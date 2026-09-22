import { memo, useEffect, useRef } from "react";
import { spectrogramLogger } from "../logger";
import styles from "./AudioSpectrogram.module.css";

export interface TileComponentProps {
	tileId: string;
	left: number;
	width: number;
	/** 已经算好的位图；没有时画布保持空白，只显示占位底色 */
	bitmap?: ImageBitmap;
}

export const TileComponent = memo(
	({ tileId, left, width, bitmap }: TileComponentProps) => {
		const canvasRef = useRef<HTMLCanvasElement>(null);

		// 画布的 width/height 属性完全由这里管理，React 不再碰它们。
		//
		// 浏览器在 canvas 的 width/height 属性变化时会把内容清空，而参数变化
		// （对数程度 / 重分配 / 增益 / 高度…）会让整屏瓦片一起重算；如果让
		// React 去改属性，旧频谱就会在重算期间被清成空白。所以这里改成：
		// 只有拿到新的位图时才动属性并覆盖绘制，拿不到时画布原样保留，
		// 旧频谱可以一直顶着。
		useEffect(() => {
			const canvas = canvasRef.current;
			if (!canvas || !bitmap) return;

			// 已经被 close() 的位图宽高是 0，画上去只会把画布弄坏
			if (bitmap.width <= 0 || bitmap.height <= 0) return;

			const ctx = canvas.getContext("2d");
			if (!ctx) return;

			try {
				if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
				if (canvas.height !== bitmap.height) canvas.height = bitmap.height;

				ctx.clearRect(0, 0, canvas.width, canvas.height);
				ctx.drawImage(bitmap, 0, 0);
			} catch (e) {
				spectrogramLogger.warn(`绘制瓦片 ${tileId} 失败:`, e);
			}
		}, [bitmap, tileId]);

		return (
			<canvas
				ref={canvasRef}
				id={tileId}
				className={styles.tileCanvas}
				style={{
					left: `${left}px`,
					width: `${width}px`,
					backgroundColor: bitmap ? "transparent" : "var(--gray-3)",
				}}
			/>
		);
	},
);
