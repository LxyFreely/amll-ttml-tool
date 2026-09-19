import {
	Button,
	Flex,
	Select,
	Slider,
	Switch,
	Text,
	TextField,
} from "@radix-ui/themes";
import { useAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	customPaletteStopsAtom,
	predefinedPalettes,
	REASSIGN_FFT_SIZE_OPTIONS,
	REASSIGN_OVERLAP_OPTIONS,
	selectedPaletteIdAtom,
	spectrogramLogAmountAtom,
	spectrogramReassignAppliedAtom,
	spectrogramReassignAtom,
	spectrogramReassignFftSizeAtom,
	spectrogramReassignOverlapAtom,
} from "$/modules/spectrogram/states";

export const SettingsSpectrogramTab = () => {
	const { t } = useTranslation();
	const [selectedPaletteId, setSelectedPaletteId] = useAtom(
		selectedPaletteIdAtom,
	);
	const [globalStops, setGlobalStops] = useAtom(customPaletteStopsAtom);
	const [localStops, setLocalStops] = useState(globalStops);
	const [logAmount, setLogAmount] = useAtom(spectrogramLogAmountAtom);
	const [reassign, setReassign] = useAtom(spectrogramReassignAtom);
	const [reassignFftSize, setReassignFftSize] = useAtom(
		spectrogramReassignFftSizeAtom,
	);
	const [reassignOverlap, setReassignOverlap] = useAtom(
		spectrogramReassignOverlapAtom,
	);
	const [reassignApplied, setReassignApplied] = useAtom(
		spectrogramReassignAppliedAtom,
	);
	const reassignDirty =
		reassignFftSize !== reassignApplied.fftSize ||
		reassignOverlap !== reassignApplied.overlapPercent ||
		logAmount !== reassignApplied.logAmount;
	const applyReassignConfig = () => {
		setReassignApplied({
			fftSize: reassignFftSize,
			overlapPercent: reassignOverlap,
			logAmount,
		});
	};

	useEffect(() => {
		setLocalStops(globalStops);
	}, [globalStops]);

	const gradientCss = useMemo(() => {
		const stopsString = localStops
			.map((stop) => `${stop.color} ${stop.pos * 100}%`)
			.join(", ");
		return `linear-gradient(to right, ${stopsString})`;
	}, [localStops]);

	const handleStopColorChange = (index: number, color: string) => {
		setLocalStops(
			localStops.map((stop, i) => (i === index ? { ...stop, color } : stop)),
		);
	};

	const handleStopPosChange = (index: number, pos: number) => {
		const newPos = Number.isNaN(pos) ? 0 : Math.max(0, Math.min(1, pos));

		setLocalStops(
			localStops.map((stop, i) =>
				i === index ? { ...stop, pos: newPos } : stop,
			),
		);
	};

	const commitLocalChanges = () => {
		const sortedStops = [...localStops].sort((a, b) => a.pos - b.pos);
		setGlobalStops(sortedStops);
		setLocalStops(sortedStops);
	};

	const handleRemoveStop = (index: number) => {
		setGlobalStops(globalStops.filter((_, i) => i !== index));
	};

	const handleAddStop = () => {
		setGlobalStops(
			[
				...globalStops,
				{
					id: crypto.randomUUID(),
					pos: 1.0,
					color: "#ffffff",
				},
			].sort((a, b) => a.pos - b.pos),
		);
	};

	return (
		<Flex direction="column" gap="4">
			<Flex direction="column" gap="2">
				<Flex align="center" justify="between" gap="2">
					<Text>{t("settings.spectrogram.frequencyAxis", "频率轴")}</Text>
					<Text size="1" color="gray">
						{logAmount <= 0
							? t("spectrogram.linear", "线性")
							: t("spectrogram.logarithmic", "对数 {percent}%", {
									percent: Math.round(logAmount * 100),
								})}
					</Text>
				</Flex>
				<Slider
					min={0}
					max={1}
					step={0.01}
					value={[logAmount]}
					onValueChange={(v) => setLogAmount(v[0])}
				/>
				<Text size="1" color="gray">
					{t(
						"settings.spectrogram.logAmountDesc",
						"控制频率重分配曲线的对数程度：0 为线性，1 为完全对数，低频会占用更多行。",
					)}
				</Text>
			</Flex>

			<Flex direction="column" gap="2">
				<Flex align="center" justify="between" gap="2">
					<Text>{t("spectrogram.reassign", "频率重分配")}</Text>
					<Switch checked={reassign} onCheckedChange={setReassign} />
				</Flex>
				<Text size="1" color="gray">
					{t(
						"settings.spectrogram.reassignDesc",
						"使用相位声码器估计瞬时频率并把能量重分配，频谱会锐利很多，但计算量更大。",
					)}
				</Text>
			</Flex>

			{reassign && (
				<Flex direction="column" gap="3">
					<Flex direction="column" gap="2" align="start">
						<Text size="2">{t("spectrogram.fftSize", "FFT 窗口大小")}</Text>
						<Select.Root
							value={String(reassignFftSize)}
							onValueChange={(v) => setReassignFftSize(Number(v))}
						>
							<Select.Trigger />
							<Select.Content>
								{REASSIGN_FFT_SIZE_OPTIONS.map((size) => (
									<Select.Item key={size} value={String(size)}>
										{size}
									</Select.Item>
								))}
							</Select.Content>
						</Select.Root>
						<Text size="1" color="gray">
							{t(
								"settings.spectrogram.fftSizeDesc",
								"越大频率分辨率越高，但时间分辨率越低、计算量越大。",
							)}
						</Text>
					</Flex>

					<Flex direction="column" gap="2" align="start">
						<Text size="2">{t("spectrogram.overlap", "重叠")}</Text>
						<Select.Root
							value={String(reassignOverlap)}
							onValueChange={(v) => setReassignOverlap(Number(v))}
						>
							<Select.Trigger />
							<Select.Content>
								{REASSIGN_OVERLAP_OPTIONS.map((value) => (
									<Select.Item key={value} value={String(value)}>
										{value}%
									</Select.Item>
								))}
							</Select.Content>
						</Select.Root>
						<Text size="1" color="gray">
							{t(
								"settings.spectrogram.overlapDesc",
								"重叠越高，横向（时间）分辨率越高，计算量也随之增加。",
							)}
						</Text>
					</Flex>

					<Button
						onClick={applyReassignConfig}
						disabled={!reassignDirty}
						variant={reassignDirty ? "solid" : "soft"}
					>
						{t("spectrogram.applyReassign", "应用并重新计算")}
					</Button>
					<Text size="1" color="gray">
						{reassignDirty
							? t(
									"spectrogram.reassignPending",
									"参数已修改，点击按钮后才会重新计算。",
								)
							: t("spectrogram.reassignApplied", "参数已生效。")}
					</Text>
				</Flex>
			)}

			<Text as="label">
				<Flex direction="column" gap="2" align="start">
					<Text>{t("settings.spectrogram.palette", "配色方案")}</Text>
					<Select.Root
						value={selectedPaletteId}
						onValueChange={(v) => setSelectedPaletteId(v)}
					>
						<Select.Trigger />
						<Select.Content>
							{predefinedPalettes.map((palette) => (
								<Select.Item key={palette.id} value={palette.id}>
									{palette.name}
								</Select.Item>
							))}
							<Select.Separator />
							<Select.Item value="custom">
								{t("settings.spectrogram.paletteCustom", "自定义")}
							</Select.Item>
						</Select.Content>
					</Select.Root>
				</Flex>
			</Text>

			{selectedPaletteId === "custom" && (
				<Flex
					asChild
					p="2"
					style={{
						border: "1px solid var(--gray-a5)",
						borderRadius: "var(--radius-3)",
					}}
				>
					<section>
						<Flex direction="column" gap="3" width="100%">
							<Text size="1" color="gray">
								{t(
									"settings.spectrogram.gradientEditorDesc",
									"Pos 0.0 对应最安静的部分，1.0 对应最响亮的部分。建议 Pos 越大，使用亮度越高的颜色。",
								)}
							</Text>

							<div
								style={{
									width: "100%",
									height: "24px",
									backgroundImage: gradientCss,
									border: "1px solid var(--gray-a6)",
									borderRadius: "var(--radius-2)",
								}}
							/>

							{localStops.map((stop, index) => (
								<Flex key={stop.id} align="center" gap="2">
									<input
										type="color"
										value={stop.color}
										onChange={(e) =>
											handleStopColorChange(index, e.target.value)
										}
										onBlur={commitLocalChanges}
										style={{
											border: "none",
											padding: 0,
											background: "none",
											width: "28px",
											height: "28px",
										}}
									/>
									<TextField.Root
										type="number"
										min={0}
										max={1}
										step={0.01}
										value={stop.pos}
										onChange={(e) =>
											handleStopPosChange(
												index,
												e.target.value === ""
													? NaN
													: Number.parseFloat(e.target.value),
											)
										}
										onBlur={commitLocalChanges}
										style={{ maxWidth: "80px" }}
									/>
									<Text size="1">Pos: {stop.pos.toFixed(2)}</Text>
									<Button
										variant="soft"
										color="red"
										disabled={localStops.length <= 1}
										onClick={() => handleRemoveStop(index)}
										style={{ marginLeft: "auto" }}
									>
										{t("common.remove", "移除")}
									</Button>
								</Flex>
							))}
							<Button variant="outline" onClick={handleAddStop}>
								{t("settings.spectrogram.addStop", "添加色标")}
							</Button>
						</Flex>
					</section>
				</Flex>
			)}
		</Flex>
	);
};
