// 导入 WebAssembly 光谱图生成库
import init, {
	generate_spectrogram_image,  // 生成光谱图图像函数
	initThreadPool,              // 初始化线程池函数
	SpectrogramConfig,           // 光谱图配置类
} from "$/modules/spectrogram/vendor";
// 导入光谱图工作线程作用域类型
import type { SpectrogramWorkerScope } from "$/modules/spectrogram/workers/types";

// 将当前工作线程上下文转换为光谱图工作线程作用域
const ctx: SpectrogramWorkerScope = self as SpectrogramWorkerScope;

// 工作线程全局变量
let fullAudioData: Float32Array | null = null;  // 完整音频数据
let audioSampleRate: number = 0;                 // 音频采样率
let wasmInitialized: Promise<void> | null = null; // WASM初始化状态
let currentPalette: Uint8Array | null = null;    // 当前调色板

// 初始化 WASM 模块和线程池
async function initializeWasm() {
	if (!wasmInitialized) {
		wasmInitialized = (async () => {
			await init();  // 初始化 WASM 模块
			// 初始化线程池，使用可用的硬件并发数
			await initThreadPool(navigator.hardwareConcurrency);
		})();
	}
	await wasmInitialized;
}

// 设置工作线程消息处理器
ctx.onmessage = async (event) => {
	await initializeWasm();

	const msg = event.data;

	switch (msg.type) {
		case "INIT":  // 初始化消息
			fullAudioData = msg.audioData;  // 存储音频数据
			audioSampleRate = msg.sampleRate;  // 存储采样率
			currentPalette = null;  // 清空调色板
			// 发送初始化完成消息
			ctx.postMessage({ type: "INIT_COMPLETE" });
			break;
		case "SET_PALETTE":  // 设置调色板消息
			currentPalette = msg.palette;  // 存储新的调色板
			break;
		case "GET_TILE": {  // 获取瓦片数据消息
				const { reqId, params } = msg;

				// 检查工作线程是否已准备好
				if (!fullAudioData || !audioSampleRate || !currentPalette) {
					ctx.postMessage({
						type: "ERROR",
						reqId,
						message: "Worker not ready",
					});
					return;
				}

				// 解构参数
				const { startTime, endTime, gain, tileWidthPx, height } = params;

				// 计算开始和结束样本索引
				const startSample = Math.floor(startTime * audioSampleRate);
				const endSample = Math.ceil(endTime * audioSampleRate);

				// 检查样本范围是否有效
				if (startSample >= fullAudioData.length) {
					ctx.postMessage({
						type: "ERROR",
						reqId,
						message: "Out of bounds",
					});
					return;
				}
				// 截取指定时间范围内的音频数据
				const audioSlice = fullAudioData.subarray(
					startSample,
					Math.min(endSample, fullAudioData.length),
				);

				// 定义快速傅里叶变换参数
				const FFT_SIZE = 1024;   // FFT 大小
				const HOP_LENGTH = 64;   // 跳跃长度

				try {
					// 创建光谱图配置对象
					const config = new SpectrogramConfig(
						audioSampleRate,  // 音频采样率
						FFT_SIZE,        // FFT 大小
						HOP_LENGTH,      // 跳跃长度
						tileWidthPx,     // 瓦片宽度（像素）
						height,         // 高度
						gain,            // 增益
					);

					// 生成光谱图像素数据
					const pixelData = generate_spectrogram_image(
						audioSlice,      // 音频切片
						currentPalette,  // 当前调色板
						config,          // 配置对象
					);

					// 释放配置对象内存
					config.free();

					// 创建离屏 Canvas 用于绘制图像
					const canvas = new OffscreenCanvas(tileWidthPx, height);
					const context = canvas.getContext("2d");
					if (!context) throw new Error("OffscreenCanvas context 失败");

					// 创建图像数据对象
					const imageData = new ImageData(
						new Uint8ClampedArray(pixelData),  // 像素数据
						tileWidthPx,                     // 宽度
						height,                         // 高度
					);
					// 将图像数据绘制到 Canvas 上
					context.putImageData(imageData, 0, 0);

				const imageBitmap = canvas.transferToImageBitmap();
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