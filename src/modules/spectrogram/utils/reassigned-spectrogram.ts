import { frequencyToRowIndex } from "./frequency-mapping";

/**
 * @description 根据 FFT 大小与重叠百分比计算帧移
 */
export function hopLengthFromOverlap(
	fftSize: number,
	overlapPercent: number,
): number {
	const overlap = Math.min(95, Math.max(0, overlapPercent));
	const hop = Math.round((fftSize * (100 - overlap)) / 100);
	return Math.max(1, hop);
}

interface Radix2Fft {
	transform(re: Float32Array, im: Float32Array): void;
}

const fftCache = new Map<number, Radix2Fft>();
const windowCache = new Map<number, Float32Array>();

/**
 * @description 迭代式 radix-2 复数 FFT（原地计算）
 */
class InPlaceRadix2Fft implements Radix2Fft {
	readonly size: number;
	private readonly reverse: Uint32Array;
	private readonly cos: Float32Array;
	private readonly sin: Float32Array;

	constructor(size: number) {
		if (size < 2 || (size & (size - 1)) !== 0) {
			throw new Error("FFT 大小必须是 2 的幂");
		}
		this.size = size;

		let bits = 0;
		while (1 << bits < size) bits++;

		const reverse = new Uint32Array(size);
		for (let i = 0; i < size; i++) {
			let r = 0;
			for (let b = 0; b < bits; b++) {
				if (i & (1 << b)) r |= 1 << (bits - 1 - b);
			}
			reverse[i] = r;
		}
		this.reverse = reverse;

		const half = size >> 1;
		const cos = new Float32Array(half);
		const sin = new Float32Array(half);
		for (let i = 0; i < half; i++) {
			const angle = (-2 * Math.PI * i) / size;
			cos[i] = Math.cos(angle);
			sin[i] = Math.sin(angle);
		}
		this.cos = cos;
		this.sin = sin;
	}

	transform(re: Float32Array, im: Float32Array): void {
		const n = this.size;
		const reverse = this.reverse;
		for (let i = 0; i < n; i++) {
			const j = reverse[i];
			if (j > i) {
				const tr = re[i];
				re[i] = re[j];
				re[j] = tr;
				const ti = im[i];
				im[i] = im[j];
				im[j] = ti;
			}
		}

		const cos = this.cos;
		const sin = this.sin;
		for (let len = 2; len <= n; len <<= 1) {
			const half = len >> 1;
			const step = n / len;
			for (let base = 0; base < n; base += len) {
				for (let j = 0, k = 0; j < half; j++, k += step) {
					const l = base + j;
					const r = l + half;
					const c = cos[k];
					const s = sin[k];
					const tre = re[r] * c - im[r] * s;
					const tim = re[r] * s + im[r] * c;
					re[r] = re[l] - tre;
					im[r] = im[l] - tim;
					re[l] += tre;
					im[l] += tim;
				}
			}
		}
	}
}

function getFft(size: number): Radix2Fft {
	let fft = fftCache.get(size);
	if (!fft) {
		fft = new InPlaceRadix2Fft(size);
		fftCache.set(size, fft);
	}
	return fft;
}

/**
 * @description 周期性 Hann 窗
 */
function getHannWindow(size: number): Float32Array {
	let window = windowCache.get(size);
	if (!window) {
		window = new Float32Array(size);
		for (let i = 0; i < size; i++) {
			window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
		}
		windowCache.set(size, window);
	}
	return window;
}

const MAGIC_SUB = (1 << 23) * (127 - 0.058145);
const MULTIPLIER = 1 / (1 << 23);
/** log10(2)，用于把 log2 结果换算为 log10 结果 */
const LOG10_2 = Math.LOG10E * Math.LN2;

const floatBuffer = new Float32Array(1);
const intBuffer = new Uint32Array(floatBuffer.buffer);

/**
 * @description 把线性幅度映射为 0~255 的调色板索引
 *
 * 使用与 wasm-spectrogram 相同的快速对数近似，保证增益滑块的观感一致。
 */
export function magnitudeToColorIndex(
	scaledMagnitude: number,
	gain: number,
): number {
	const x = scaledMagnitude + 1;
	floatBuffer[0] = x;
	const fastLog2 = (intBuffer[0] - MAGIC_SUB) * MULTIPLIER;
	const value = fastLog2 * LOG10_2 * gain;
	if (value <= 0) return 0;
	if (value >= 1) return 255;
	return (value * 255 + 0.5) | 0;
}

export interface ReassignedSpectrogramOptions {
	sampleRate: number;
	fftSize: number;
	hopLength: number;
	/** 输出列数（时间轴像素） */
	width: number;
	/** 输出行数（频率轴像素） */
	height: number;
	gain: number;
	logAmount: number;
	/** 频率轴最低频率（Hz） */
	minFrequency: number;
	/** 频率轴最高频率（Hz） */
	maxFrequency: number;
}

/**
 * @description 生成相位声码器频率重分配频谱
 *
 * 对每一帧做 STFT，用相邻帧的相位差估计每个频率 bin 的瞬时频率，
 * 再把该 bin 的能量搬到瞬时频率对应的显示行上，从而得到远比普通
 * 频谱锐利的时频图（类似于 Wave Candy / MiniMeters 的重分配显示）。
 *
 * 返回按行优先排列的调色板索引（长度 width * height），
 * 行 0 为最顶行（最高频）。
 */
export function renderReassignedSpectrogram(
	audio: Float32Array,
	options: ReassignedSpectrogramOptions,
): Uint8Array {
	const {
		sampleRate,
		fftSize,
		hopLength,
		width,
		height,
		gain,
		logAmount,
		minFrequency,
		maxFrequency,
	} = options;

	const output = new Uint8Array(width * height);
	if (width <= 0 || height <= 0 || fftSize < 2) return output;

	const frameCount =
		audio.length >= fftSize
			? Math.floor((audio.length - fftSize) / hopLength) + 1
			: 0;
	if (frameCount <= 0) return output;

	const fft = getFft(fftSize);
	const window = getHannWindow(fftSize);
	const bins = (fftSize >> 1) + 1;
	const twoPi = Math.PI * 2;
	const binFrequencyStep = sampleRate / fftSize;

	const re = new Float32Array(fftSize);
	const im = new Float32Array(fftSize);
	const magnitude = new Float32Array(bins);
	const phase = new Float32Array(bins);
	const previousPhase = new Float32Array(bins);

	/**
	 * 第一帧没有上一帧的相位，无法估计瞬时频率，因此只把它当作
	 * 第二帧的参考，不写入输出，避免首帧被 smearing 成多行。
	 */
	const firstValidFrame = frameCount > 1 ? 1 : 0;

	/** 帧优先的重分配结果，索引为 frame * height + row */
	const frameOutput = new Float32Array(frameCount * height);

	for (let frame = 0; frame < frameCount; frame++) {
		const offset = frame * hopLength;
		for (let n = 0; n < fftSize; n++) {
			re[n] = audio[offset + n] * window[n];
			im[n] = 0;
		}

		fft.transform(re, im);

		let maxMagnitude = 0;
		for (let k = 0; k < bins; k++) {
			const r = re[k];
			const i = im[k];
			const m = Math.sqrt(r * r + i * i);
			magnitude[k] = m;
			phase[k] = Math.atan2(i, r);
			if (m > maxMagnitude) maxMagnitude = m;
		}

		// 过弱的 bin 相位基本是噪声，直接按 bin 中心频率摆放，避免噪声被乱搬
		const threshold = maxMagnitude * 1e-4;
		const frameBase = frame * height;
		const accumulate = frame >= firstValidFrame;

		for (let k = 0; k < bins; k++) {
			const m = magnitude[k];
			if (m <= 0) continue;

			let frequency: number;
			if (frame > 0 && m > threshold) {
				const omega = (twoPi * k) / fftSize;
				let delta = phase[k] - previousPhase[k] - omega * hopLength;
				delta -= twoPi * Math.round(delta / twoPi);
				frequency = (omega + delta / hopLength) * (sampleRate / twoPi);
			} else {
				frequency = k * binFrequencyStep;
			}

			if (frequency < minFrequency || frequency > maxFrequency) continue;

			const row = frequencyToRowIndex(
				frequency,
				minFrequency,
				maxFrequency,
				height,
				logAmount,
			);
			if (!accumulate) continue;

			const index = frameBase + row;
			if (m > frameOutput[index]) frameOutput[index] = m;
		}

		previousPhase.set(phase);
	}

	// 帧 -> 列（与 wasm-spectrogram 的时间映射一致），再映射到调色板索引
	const timeRatio = (frameCount - 1) / width;
	const columnFrame = new Int32Array(width);
	for (let x = 0; x < width; x++) {
		let frame = Math.floor(x * timeRatio + 0.5);
		if (frame >= frameCount) frame = frameCount - 1;
		if (frame < firstValidFrame) frame = firstValidFrame;
		columnFrame[x] = frame;
	}

	// Hann 窗相干增益为 0.5，这里乘 2 补偿，使增益滑块与普通频谱观感接近
	const scaleFactor = (9.0 / Math.sqrt(2 * fftSize)) * 2.0;

	for (let row = 0; row < height; row++) {
		for (let x = 0; x < width; x++) {
			const m = frameOutput[columnFrame[x] * height + row];
			output[row * width + x] =
				m > 0 ? magnitudeToColorIndex(m * scaleFactor, gain) : 0;
		}
	}

	return output;
}

/**
 * @description 计算重分配频谱对应的频率轴范围
 *
 * 使用与普通频谱相同的频率轴（以 {@link baseFftSize} 的频率分辨率为下限），
 * 这样切换重分配模式时频率刻度不会跳动。
 */
export function computeReassignAxis(
	sampleRate: number,
	baseFftSize: number,
	maxFrequency: number,
): { minFrequency: number; maxFrequency: number } {
	const resolution = sampleRate / baseFftSize;
	return { minFrequency: resolution, maxFrequency };
}
