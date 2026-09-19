import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
	type ColorStop,
	generateLutFromStops,
	generatePalette,
	getGrayscaleColor,
	getGreenColor,
	getIcyBlueColor,
} from "$/modules/spectrogram/utils/colors";

export const spectrogramGainAtom = atomWithStorage(
	"settings_spectrogramGain",
	3.0,
);
export const spectrogramZoomAtom = atomWithStorage(
	"settings_spectrogramZoom",
	200,
);
export const spectrogramHeightAtom = atomWithStorage(
	"settings_spectrogramHeight",
	256,
);
/**
 * @description 频率轴的对数程度
 *
 * - `0` 完全线性
 * - `1` 完全对数（低频占用更多行）
 */
export const spectrogramLogAmountAtom = atomWithStorage(
	"settings_spectrogramLogAmount",
	0,
);
/**
 * @description 是否启用相位声码器频率重分配（更锐利的频谱）
 */
export const spectrogramReassignAtom = atomWithStorage(
	"settings_spectrogramReassign",
	false,
);

/**
 * @description 重分配频谱的可应用参数
 */
export interface ReassignConfig {
	/** FFT 窗口大小 */
	fftSize: number;
	/** 帧重叠百分比，越大时间分辨率越高、计算量越大 */
	overlapPercent: number;
	/** 频率轴对数程度 */
	logAmount: number;
}

export const DEFAULT_REASSIGN_CONFIG: ReassignConfig = {
	fftSize: 2048,
	overlapPercent: 87.5,
	logAmount: 0,
};

/** 可选的 FFT 窗口大小 */
export const REASSIGN_FFT_SIZE_OPTIONS = [512, 1024, 2048, 4096, 8192];
/** 可选的帧重叠百分比 */
export const REASSIGN_OVERLAP_OPTIONS = [0, 50, 75, 87.5, 93.75];

/**
 * @description 重分配参数草稿，拖动滑块时只改这里，不会触发重新计算
 */
export const spectrogramReassignFftSizeAtom = atomWithStorage(
	"settings_spectrogramReassignFftSize",
	DEFAULT_REASSIGN_CONFIG.fftSize,
);
export const spectrogramReassignOverlapAtom = atomWithStorage(
	"settings_spectrogramReassignOverlap",
	DEFAULT_REASSIGN_CONFIG.overlapPercent,
);
/**
 * @description 已应用的重分配参数，只有点击「应用」时才更新
 */
export const spectrogramReassignAppliedAtom = atomWithStorage<ReassignConfig>(
	"settings_spectrogramReassignApplied",
	DEFAULT_REASSIGN_CONFIG,
);
export const spectrogramScrollLeftAtom = atom(0);
export const spectrogramContainerWidthAtom = atom(0);

const icyBluePalette = {
	id: "icy_blue",
	name: "Icy Blue",
	data: generatePalette(getIcyBlueColor),
};

const grayscalePalette = {
	id: "grayscale",
	name: "Gray Scale",
	data: generatePalette(getGrayscaleColor),
};

const aegisubGreenPalette = {
	id: "aegisub_green",
	name: "Green",
	data: generatePalette(getGreenColor),
};

export const predefinedPalettes = [
	icyBluePalette,
	aegisubGreenPalette,
	grayscalePalette,
];

export const selectedPaletteIdAtom = atomWithStorage<string>(
	"settings_selectedPaletteId",
	"icy_blue",
);

export const customPaletteStopsAtom = atomWithStorage<ColorStop[]>(
	"settings_customPaletteStops",
	[
		{ id: crypto.randomUUID(), pos: 0.0, color: "#000000" },
		{ id: crypto.randomUUID(), pos: 0.5, color: "#ff0000" },
		{ id: crypto.randomUUID(), pos: 1.0, color: "#ffff00" },
	],
);

export const currentPaletteAtom = atom((get) => {
	const selectedId = get(selectedPaletteIdAtom);

	if (selectedId === "custom") {
		const stops = get(customPaletteStopsAtom);

		const paletteId =
			"custom_" +
			stops.map((s) => `${s.pos.toFixed(2)}-${s.color.substring(1)}`).join("-");

		const paletteData = generateLutFromStops(stops);

		return { id: paletteId, name: "custom", data: paletteData };
	}

	const predefined = predefinedPalettes.find((p) => p.id === selectedId);
	if (predefined) {
		return predefined;
	}

	return icyBluePalette;
});

export const spectrogramHoverPxAtom = atom(0);

export const spectrogramHoverTimeMsAtom = atom((get) => {
	const hoverPx = get(spectrogramHoverPxAtom);
	const scrollLeft = get(spectrogramScrollLeftAtom);
	const zoom = get(spectrogramZoomAtom);
	const containerWidth = get(spectrogramContainerWidthAtom);

	if (zoom <= 0) return 0;

	const clampedMouseX = Math.max(0, Math.min(hoverPx, containerWidth));
	const hoverX = scrollLeft + clampedMouseX;
	const hoverTimeS = hoverX / zoom;

	return hoverTimeS * 1000;
});
