import { useAtomValue } from "jotai";
import { type RefObject, useEffect, useRef } from "react";
import { audioEngine } from "$/modules/audio/audio-engine.ts";
import {
	type ProcessedLyricLine,
	processedLyricLinesAtom,
} from "$/modules/segmentation/utils/segment-processing.ts";

/** 字的开头在视野里走到这个比例就跳转（0.7 = 视野 70% 处） */
const FOLLOW_TRIGGER_RATIO = 0.7;

/** 跳转后把字停靠在视野的这个比例处（0.1 = 视野 10% 处） */
const FOLLOW_ANCHOR_RATIO = 0.1;

/** 视口状态的实时快照（由组件在 layout effect 里更新） */
export interface FollowViewState {
	zoom: number;
	scrollLeft: number;
	containerWidth: number;
}

/** 一个「跟随锚点」：某个字的时间区间 */
interface FollowAnchor {
	startTime: number;
	endTime: number;
}

/**
 * @description 把每一行的字摊平成按开始时间排序的锚点列表
 *
 * 只取 word 段（gap 段代表没有字在唱，播放到那里时不需要跟随）。
 */
function buildAnchors(lines: readonly ProcessedLyricLine[]): FollowAnchor[] {
	const anchors: FollowAnchor[] = [];

	for (const line of lines) {
		for (const segment of line.segments) {
			if (segment.type !== "word") continue;
			anchors.push({
				startTime: segment.startTime,
				endTime: segment.endTime,
			});
		}
	}

	return anchors.sort(
		(a, b) => a.startTime - b.startTime || a.endTime - b.endTime,
	);
}

/**
 * @description 二分查找正在播放的那个字；落在字与字的空隙（间奏）里时返回 null
 */
function findAnchorAt(
	anchors: FollowAnchor[],
	timeMs: number,
): FollowAnchor | null {
	let low = 0;
	let high = anchors.length - 1;
	let found = -1;

	while (low <= high) {
		const mid = (low + high) >> 1;
		if (anchors[mid].startTime <= timeMs) {
			found = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	if (found < 0) return null;

	const anchor = anchors[found];
	return timeMs < anchor.endTime ? anchor : null;
}

/**
 * @description 播放时自动跟随：字走到视野 70% 处就把它挪回视野 10% 处
 *
 * 只在播放中生效（暂停时点选/拖动不做跟随）。判断依据是正在唱的那个字的
 * **开头**在视野里的位置——它既不越过 70%，也没被甩到视野左边时什么都不做，
 * 所以同一个字只会触发一次，视觉上就是播放头推到 70% 时整屏往前翻一页。
 */
export function useAutoFollowPlayback(
	enabled: boolean,
	viewStateRef: RefObject<FollowViewState>,
	scrollTo: (nextScrollLeft: number, animate?: boolean) => void,
) {
	const lines = useAtomValue(processedLyricLinesAtom);
	const anchorsRef = useRef<FollowAnchor[]>([]);
	/** 上一次跳转的目标，用来保证同一个字只跳一次 */
	const lastTargetRef = useRef(Number.NaN);

	useEffect(() => {
		anchorsRef.current = buildAnchors(lines);
	}, [lines]);

	useEffect(() => {
		if (!enabled) return;

		const handleTimeUpdate = (timeInSeconds: number) => {
			if (!audioEngine.musicPlaying) return;

			const { zoom, scrollLeft, containerWidth } = viewStateRef.current;
			if (zoom <= 0 || containerWidth <= 0) return;

			const anchor = findAnchorAt(anchorsRef.current, timeInSeconds * 1000);
			if (!anchor) return;

			const startTimeS = anchor.startTime / 1000;
			const startOffsetPx = startTimeS * zoom - scrollLeft;

			// 还没走到触发线（也没被甩到视野左边）就什么都不用做
			if (
				startOffsetPx >= 0 &&
				startOffsetPx < containerWidth * FOLLOW_TRIGGER_RATIO
			) {
				return;
			}

			const targetScrollLeft =
				startTimeS * zoom - containerWidth * FOLLOW_ANCHOR_RATIO;

			// 同一个字只跳一次，避免缓动过程中每帧重复触发
			if (Math.abs(targetScrollLeft - lastTargetRef.current) < 1) return;
			lastTargetRef.current = targetScrollLeft;

			scrollTo(targetScrollLeft, true);
		};

		// 重新武装：开关拨回来或视口宽变化后，同一个字允许再跳一次
		lastTargetRef.current = Number.NaN;

		audioEngine.onTimeUpdate(handleTimeUpdate);
		return () => audioEngine.offTimeUpdate(handleTimeUpdate);
	}, [enabled, scrollTo, viewStateRef]);
}
