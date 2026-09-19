export interface TileGenerationParams {
	tileIndex: number;
	startTime: number;
	endTime: number;
	gain: number;
	height: number;
	tileWidthPx: number;
	paletteId: string;
	/** 频率轴的对数程度，0 为线性，1 为完全对数 */
	logAmount: number;
	/** 是否使用相位声码器频率重分配 */
	reassign: boolean;
	/** 重分配 FFT 窗口大小 */
	fftSize: number;
	/** 重分配帧移（由 FFT 大小与重叠百分比换算） */
	hopLength: number;
}

export type WorkerRequest =
	| { type: "INIT"; audioData: Float32Array; sampleRate: number }
	| { type: "SET_PALETTE"; palette: Uint8Array }
	| { type: "GET_TILE"; reqId: number; params: TileGenerationParams };

export type WorkerResponse =
	| { type: "INIT_COMPLETE" }
	| { type: "TILE_READY"; reqId: number; imageBitmap: ImageBitmap }
	| { type: "ERROR"; reqId: number; message: string };

export interface SpectrogramWorker extends Omit<Worker, "postMessage"> {
	postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
}

export type SpectrogramWorkerScope = Omit<
	DedicatedWorkerGlobalScope,
	"postMessage" | "onmessage"
> & {
	postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
	onmessage:
		| ((this: SpectrogramWorkerScope, ev: MessageEvent<WorkerRequest>) => void)
		| null;
};
