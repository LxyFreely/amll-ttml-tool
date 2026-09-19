import {
	computeFrequencyBinRanges,
	type FrequencyBinRanges,
} from "$/modules/spectrogram/utils/frequency-mapping";
import { renderReassignedSpectrogram } from "$/modules/spectrogram/utils/reassigned-spectrogram";
import init, {
	generate_spectrogram_image,
	initThreadPool,
	SpectrogramConfig,
} from "$/modules/spectrogram/vendor";
import type { SpectrogramWorkerScope } from "$/modules/spectrogram/workers/types";

const ctx: SpectrogramWorkerScope = self as SpectrogramWorkerScope;

/** FFT 大小，需与频谱图的时间/频率分辨率预期保持一致 */
const FFT_SIZE = 1024;
/** 帧移 */
const HOP_LENGTH = 64;
/** 渲染的最高频率 */
const MAX_RENDER_FREQUENCY = 20000;

/** 原始线性频谱缓存的字节上限 */
const RAW_CACHE_MAX_BYTES = 96 * 1024 * 1024;
/** 重分配频谱强度缓存的字节上限 */
const REASSIGN_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** 频率映射结果缓存的条目上限 */
const MAPPING_CACHE_MAX_ENTRIES = 8;

let fullAudioData: Float32Array | null = null;
let audioSampleRate = 0;
let wasmInitialized: Promise<void> | null = null;
let currentPalette: Uint8Array | null = null;

/**
 * @description 恒等调色板
 *
 * 当调色板第 i 项为 [i, i, i, 255] 时，生成像素的 R 通道恰好等于
 * 该像素的强度索引（0~255），因此可以在不损失精度的前提下取回
 * 原始的线性频谱数据，再在 TS 侧做频率重分配和上色。
 */
const IDENTITY_PALETTE = (() => {
	const lut = new Uint8Array(256 * 4);
	for (let i = 0; i < 256; i++) {
		const offset = i * 4;
		lut[offset] = i;
		lut[offset + 1] = i;
		lut[offset + 2] = i;
		lut[offset + 3] = 255;
	}
	return lut;
})();

interface RawTile {
	width: number;
	/** 频率 bin 数量 */
	bins: number;
	/** 强度索引，布局为 [x * bins + bin] */
	data: Uint8Array;
}

/** 原始线性频谱缓存，键为 瓦片索引 + 宽度 + 增益 */
const rawTileCache = new Map<string, RawTile>();
let rawTileCacheBytes = 0;
/** 频率重分配结果缓存 */
const frequencyMappingCache = new Map<string, FrequencyBinRanges>();
/** 相位声码器重分配频谱的强度索引缓存 */
const reassignCache = new Map<string, Uint8Array>();
let reassignCacheBytes = 0;

/**
 * @description 初始化 WASM 模块与线程池
 */
async function initializeWasm() {
	if (!wasmInitialized) {
		wasmInitialized = (async () => {
			await init();
			await initThreadPool(navigator.hardwareConcurrency);
		})();
	}
	await wasmInitialized;
}

/**
 * @description 与 wasm-spectrogram 内部一致地计算频率 bin 数量
 */
function getNumFreqBins(sampleRate: number): number {
	const freqResolution = sampleRate / FFT_SIZE;
	return Math.min(
		Math.round(MAX_RENDER_FREQUENCY / freqResolution),
		Math.floor(FFT_SIZE / 2),
	);
}

function cacheRawTile(key: string, tile: RawTile) {
	const existing = rawTileCache.get(key);
	if (existing) {
		rawTileCacheBytes -= existing.data.byteLength;
		rawTileCache.delete(key);
	}
	rawTileCache.set(key, tile);
	rawTileCacheBytes += tile.data.byteLength;

	while (rawTileCacheBytes > RAW_CACHE_MAX_BYTES && rawTileCache.size > 1) {
		const oldestKey = rawTileCache.keys().next().value;
		if (oldestKey === undefined) break;
		const oldest = rawTileCache.get(oldestKey);
		rawTileCache.delete(oldestKey);
		if (oldest) rawTileCacheBytes -= oldest.data.byteLength;
	}
}

/**
 * @description 生成（或从缓存读取）一个瓦片的原始线性频谱
 */
function getRawTile(params: {
	tileIndex: number;
	startTime: number;
	endTime: number;
	gain: number;
	tileWidthPx: number;
}): RawTile | null {
	if (!fullAudioData || !audioSampleRate) return null;

	const bins = getNumFreqBins(audioSampleRate);
	if (bins <= 0) return null;

	const key = `${params.tileIndex}|${params.tileWidthPx}|${params.gain}|${bins}`;
	const cached = rawTileCache.get(key);
	if (cached) {
		// LRU：移动到末尾
		rawTileCache.delete(key);
		rawTileCache.set(key, cached);
		return cached;
	}

	const startSample = Math.floor(params.startTime * audioSampleRate);
	const endSample = Math.ceil(params.endTime * audioSampleRate);
	if (startSample >= fullAudioData.length) return null;

	const audioSlice = fullAudioData.subarray(
		startSample,
		Math.min(endSample, fullAudioData.length),
	);

	const config = new SpectrogramConfig(
		audioSampleRate,
		FFT_SIZE,
		HOP_LENGTH,
		params.tileWidthPx,
		bins,
		params.gain,
	);

	try {
		const pixels = generate_spectrogram_image(
			audioSlice,
			IDENTITY_PALETTE,
			config,
		);

		// wasm 输出的图像自上而下对应频率从高到低，这里转置为
		// [x * bins + bin] 的布局，方便后续按 bin 连续读取
		const data = new Uint8Array(params.tileWidthPx * bins);
		for (let yPixel = 0; yPixel < bins; yPixel++) {
			const logicalRow = bins - 1 - yPixel;
			const pixelRowOffset = yPixel * params.tileWidthPx * 4;
			for (let x = 0; x < params.tileWidthPx; x++) {
				data[x * bins + logicalRow] = pixels[pixelRowOffset + x * 4];
			}
		}

		const tile: RawTile = { width: params.tileWidthPx, bins, data };
		cacheRawTile(key, tile);
		return tile;
	} finally {
		config.free();
	}
}

function cacheReassignTile(key: string, data: Uint8Array) {
	const existing = reassignCache.get(key);
	if (existing) {
		reassignCacheBytes -= existing.byteLength;
		reassignCache.delete(key);
	}
	reassignCache.set(key, data);
	reassignCacheBytes += data.byteLength;

	while (
		reassignCacheBytes > REASSIGN_CACHE_MAX_BYTES &&
		reassignCache.size > 1
	) {
		const oldestKey = reassignCache.keys().next().value;
		if (oldestKey === undefined) break;
		const oldest = reassignCache.get(oldestKey);
		reassignCache.delete(oldestKey);
		if (oldest) reassignCacheBytes -= oldest.byteLength;
	}
}

/**
 * @description 生成（或从缓存读取）相位声码器频率重分配频谱
 *
 * 频率轴与普通频谱保持一致（以普通模式的频率分辨率为下限），
 * 因此切换模式时刻度不会跳动。
 */
function getReassignedIntensity(params: {
	tileIndex: number;
	startTime: number;
	endTime: number;
	gain: number;
	tileWidthPx: number;
	height: number;
	logAmount: number;
	fftSize: number;
	hopLength: number;
}): Uint8Array | null {
	if (!fullAudioData || !audioSampleRate) return null;

	const key = `${params.tileIndex}|${params.tileWidthPx}|${params.height}|${params.gain}|${params.logAmount.toFixed(3)}|${params.fftSize}|${params.hopLength}`;
	const cached = reassignCache.get(key);
	if (cached) {
		reassignCache.delete(key);
		reassignCache.set(key, cached);
		return cached;
	}

	const startSample = Math.floor(params.startTime * audioSampleRate);
	const endSample = Math.ceil(params.endTime * audioSampleRate);
	if (startSample >= fullAudioData.length) return null;

	const audioSlice = fullAudioData.subarray(
		startSample,
		Math.min(endSample, fullAudioData.length),
	);

	const data = renderReassignedSpectrogram(audioSlice, {
		sampleRate: audioSampleRate,
		fftSize: params.fftSize,
		hopLength: params.hopLength,
		width: params.tileWidthPx,
		height: params.height,
		gain: params.gain,
		logAmount: params.logAmount,
		minFrequency: audioSampleRate / FFT_SIZE,
		maxFrequency: MAX_RENDER_FREQUENCY,
	});

	cacheReassignTile(key, data);
	return data;
}

/**
 * @description 把调色板索引缓冲着色为位图
 */
function colorizeIndexed(
	indices: Uint8Array,
	width: number,
	height: number,
	palette: Uint8Array,
): ImageBitmap {
	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let i = 0, offset = 0; i < indices.length; i++, offset += 4) {
		const intensity = indices[i] * 4;
		rgba[offset] = palette[intensity];
		rgba[offset + 1] = palette[intensity + 1];
		rgba[offset + 2] = palette[intensity + 2];
		rgba[offset + 3] = palette[intensity + 3];
	}

	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("OffscreenCanvas 上下文创建失败");

	context.putImageData(new ImageData(rgba, width, height), 0, 0);
	return canvas.transferToImageBitmap();
}

/**
 * @description 获取频率重分配映射（带缓存）
 */
function getFrequencyRanges(
	bins: number,
	height: number,
	logAmount: number,
): FrequencyBinRanges {
	const key = `${bins}|${height}|${logAmount.toFixed(3)}`;
	const cached = frequencyMappingCache.get(key);
	if (cached) return cached;

	const ranges = computeFrequencyBinRanges(bins, height, logAmount);
	frequencyMappingCache.set(key, ranges);

	while (frequencyMappingCache.size > MAPPING_CACHE_MAX_ENTRIES) {
		const oldestKey = frequencyMappingCache.keys().next().value;
		if (oldestKey === undefined) break;
		frequencyMappingCache.delete(oldestKey);
	}

	return ranges;
}

/**
 * @description 将原始线性频谱按频率重分配结果渲染为位图
 */
function renderTile(
	raw: RawTile,
	ranges: FrequencyBinRanges,
	height: number,
	palette: Uint8Array,
): ImageBitmap {
	const width = raw.width;
	const bins = raw.bins;
	const data = raw.data;
	const lastBin = bins - 1;
	const { start, end } = ranges;

	const rgba = new Uint8ClampedArray(width * height * 4);

	for (let y = 0; y < height; y++) {
		const binStart = start[y];
		const binEnd = end[y];
		let offset = y * width * 4;

		if (binStart >= binEnd) {
			// 单个 bin 直接放大到整行
			const bin = binStart > lastBin ? lastBin : binStart;
			for (let x = 0; x < width; x++) {
				const intensity = data[x * bins + bin] * 4;
				rgba[offset] = palette[intensity];
				rgba[offset + 1] = palette[intensity + 1];
				rgba[offset + 2] = palette[intensity + 2];
				rgba[offset + 3] = palette[intensity + 3];
				offset += 4;
			}
		} else {
			// 多个 bin 取最大值，避免重采样时丢失高能量
			for (let x = 0; x < width; x++) {
				const base = x * bins;
				let maxValue = 0;
				for (let bin = binStart; bin < binEnd; bin++) {
					const value = data[base + bin];
					if (value > maxValue) maxValue = value;
				}
				const intensity = maxValue * 4;
				rgba[offset] = palette[intensity];
				rgba[offset + 1] = palette[intensity + 1];
				rgba[offset + 2] = palette[intensity + 2];
				rgba[offset + 3] = palette[intensity + 3];
				offset += 4;
			}
		}
	}

	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("OffscreenCanvas 上下文创建失败");

	context.putImageData(new ImageData(rgba, width, height), 0, 0);
	return canvas.transferToImageBitmap();
}

ctx.onmessage = async (event) => {
	await initializeWasm();

	const msg = event.data;

	switch (msg.type) {
		case "INIT": {
			fullAudioData = msg.audioData;
			audioSampleRate = msg.sampleRate;
			currentPalette = null;
			rawTileCache.clear();
			rawTileCacheBytes = 0;
			frequencyMappingCache.clear();
			reassignCache.clear();
			reassignCacheBytes = 0;
			ctx.postMessage({ type: "INIT_COMPLETE" });
			break;
		}
		case "SET_PALETTE": {
			currentPalette = msg.palette;
			break;
		}
		case "GET_TILE": {
			const { reqId, params } = msg;

			if (!fullAudioData || !audioSampleRate || !currentPalette) {
				ctx.postMessage({
					type: "ERROR",
					reqId,
					message: "Worker not ready",
				});
				break;
			}

			try {
				if (params.reassign) {
					const intensity = getReassignedIntensity(params);
					if (!intensity) {
						ctx.postMessage({
							type: "ERROR",
							reqId,
							message: "Out of bounds",
						});
						break;
					}
					const imageBitmap = colorizeIndexed(
						intensity,
						params.tileWidthPx,
						params.height,
						currentPalette,
					);
					ctx.postMessage(
						{
							type: "TILE_READY",
							reqId,
							imageBitmap,
						},
						[imageBitmap],
					);
					break;
				}

				const raw = getRawTile(params);
				if (!raw) {
					ctx.postMessage({
						type: "ERROR",
						reqId,
						message: "Out of bounds",
					});
					break;
				}

				const ranges = getFrequencyRanges(
					raw.bins,
					params.height,
					params.logAmount,
				);
				const imageBitmap = renderTile(
					raw,
					ranges,
					params.height,
					currentPalette,
				);

				ctx.postMessage(
					{
						type: "TILE_READY",
						reqId,
						imageBitmap,
					},
					[imageBitmap],
				);
			} catch (e) {
				ctx.postMessage({
					type: "ERROR",
					reqId,
					message: (e as Error).message,
				});
			}
			break;
		}
	}
};
