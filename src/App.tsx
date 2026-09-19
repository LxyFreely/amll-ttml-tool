/*
 * Copyright 2023-2025 Steve Xiao (stevexmh@qq.com) and contributors.
 *
 * 本源代码文件是属于 AMLL TTML Tool 项目的一部分。
 * This source code file is a part of AMLL TTML Tool project.
 * 本项目的源代码的使用受到 GNU GENERAL PUBLIC LICENSE version 3 许可证的约束，具体可以参阅以下链接。
 * Use of this source code is governed by the GNU GPLv3 license that can be found through the following link.
 *
 * https://github.com/amll-dev/amll-ttml-tool/blob/main/LICENSE
 */

// 导入 Radix UI 组件库中的基本组件
import {
	Box,
	Button,
	Flex,
	Heading,
	Text,
	TextArea,
	Theme,
} from "@radix-ui/themes";
// 导入延迟加载占位符组件
import SuspensePlaceHolder from "$/components/SuspensePlaceHolder";
// 导入触摸同步面板组件
import { TouchSyncPanel } from "$/modules/lyric-editor/components/TouchSyncPanel/index.tsx";
// 导入日志记录工具函数
import { log, error as logError } from "$/utils/logging.ts";
// 导入 Radix UI 主题样式
import "@radix-ui/themes/styles.css";
// 导入 Tauri 应用核心 API 和窗口控制 API
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
// 导入平台检测相关 API
import { platform, version } from "@tauri-apps/plugin-os";
// 导入 Framer Motion 动画库
import { AnimatePresence, motion } from "framer-motion";
// 导入 Jotai 状态管理库的相关钩子
import { useAtomValue, useSetAtom, useStore } from "jotai";
// 导入 React 基础钩子和 Suspense 组件
import { lazy, Suspense, useEffect, useRef, useState } from "react";
// 导入错误边界组件
import { ErrorBoundary } from "react-error-boundary";
// 导入国际化钩子
import { useTranslation } from "react-i18next";
// 导入 Toast 提示组件
import { ToastContainer, toast } from "react-toastify";
// 导入文件保存功能
import saveFile from "save-file";
// 导入语义化版本比较函数
import semverGt from "semver/functions/gt";
// 导入 App 组件的 CSS 模块
import styles from "./App.module.css";
// 导入其他应用组件
import DarkThemeDetector from "./components/DarkThemeDetector";
import RibbonBar from "./components/RibbonBar";
import { TitleBar } from "./components/TitleBar";
// 导入文件打开处理钩子
import { useFileOpener } from "./hooks/useFileOpener.ts";
// 导入音频控制组件和反馈钩子
import AudioControls from "./modules/audio/components/index.tsx";
import { useAudioFeedback } from "./modules/audio/hooks/useAudioFeedback.ts";
// 导入同步模式键盘绑定组件
import { SyncKeyBinding } from "./modules/lyric-editor/components/sync-keybinding.tsx";
// 导入自动保存管理器
import { AutosaveManager } from "./modules/project/autosave/AutosaveManager.tsx";
// 导入 TTML 文本导出功能
import exportTTMLText from "./modules/project/logic/ttml-writer.ts";
// 导入全局拖拽覆盖层
import { GlobalDragOverlay } from "./modules/project/modals/GlobalDragOverlay.tsx";
// 导入自定义背景设置相关的状态原子
import {
	customBackgroundBlurAtom,
	customBackgroundBrightnessAtom,
	customBackgroundImageAtom,
	customBackgroundImageInitAtom,
	customBackgroundMaskAtom,
	customBackgroundOpacityAtom,
} from "./modules/settings/modals/customBackground";
// 导入触摸同步面板显示状态
import { showTouchSyncPanelAtom } from "./modules/settings/states/sync.ts";
// 导入设置对话框状态
import { settingsDialogAtom, settingsTabAtom } from "./states/dialogs.ts";
// 导入主题、文件拖拽、歌词行等全局状态
import {
	isDarkThemeAtom,
	isGlobalFileDraggingAtom,
	lyricLinesAtom,
	ToolMode,
	toolModeAtom,
} from "./states/main.ts";
// 导入应用更新检查钩子
import { useAppUpdate } from "./utils/useAppUpdate.ts";

// 使用懒加载导入歌词行视图组件
const LyricLinesView = lazy(() => import("./modules/lyric-editor/components"));
// 使用懒加载导入 Apple Music 风格歌词包装器
const AMLLWrapper = lazy(() => import("./components/AMLLWrapper"));
// 使用懒加载导入对话框组件
const Dialogs = lazy(() => import("./components/Dialogs"));

const AppErrorPage = ({
	error,
	resetErrorBoundary,
}: {
	error: Error;
	resetErrorBoundary: () => void;
}) => {
	const store = useStore();
	const { t } = useTranslation();

	return (
		<Flex direction="column" align="center" justify="center" height="100vh">
			<Flex direction="column" align="start" justify="center" gap="2">
				<Heading>{t("app.error.title", "诶呀，出错了！")}</Heading>
				<Text>
					{t("app.error.description", "AMLL TTML Tools 在运行时出现了错误")}
				</Text>
				<Text>
					{t("app.error.checkDevTools", "具体错误详情可以在开发者工具中查询")}
				</Text>
				<Flex gap="2">
					<Button
						onClick={() => {
							try {
								const ttmlText = exportTTMLText(store.get(lyricLinesAtom));
								const b = new Blob([ttmlText], { type: "text/plain" });
								saveFile(b, "lyric.ttml").catch(logError);
							} catch (e) {
								logError("Failed to save TTML file", e);
							}
						}}
					>
						{t("app.error.saveLyrics", "尝试保存当前歌词")}
					</Button>
					<Button
						onClick={() => {
							resetErrorBoundary();
						}}
						variant="soft"
					>
						{t("app.error.tryRestart", "尝试重新进入程序")}
					</Button>
				</Flex>
				<Text>{t("app.error.details", "大致错误信息：")}</Text>
				<TextArea
					readOnly
					value={String(error)}
					style={{
						width: "100%",
						height: "8em",
					}}
				/>
			</Flex>
		</Flex>
	);
};

// 主应用组件 - 整个应用的根组件
function App() {
	// 获取各种全局状态值
	const isDarkTheme = useAtomValue(isDarkThemeAtom);                 // 是否启用暗色主题
	const toolMode = useAtomValue(toolModeAtom);                       // 当前工具模式（编辑/预览/同步）
	const showTouchSyncPanel = useAtomValue(showTouchSyncPanelAtom);     // 是否显示触摸同步面板
	const customBackgroundImage = useAtomValue(customBackgroundImageAtom); // 自定义背景图片
	const customBackgroundOpacity = useAtomValue(customBackgroundOpacityAtom); // 背景透明度
	const customBackgroundMask = useAtomValue(customBackgroundMaskAtom); // 背景遮罩
	const customBackgroundBlur = useAtomValue(customBackgroundBlurAtom); // 背景模糊度
	const customBackgroundBrightness = useAtomValue(customBackgroundBrightnessAtom); // 背景亮度
	const [hasBackground, setHasBackground] = useState(false);         // 是否有背景效果
	// 确定实际使用的主题（如果有自定义背景则强制使用浅色主题）
	const effectiveTheme = customBackgroundImage
		? "light"  // 如果设置了自定义背景，则强制使用浅色主题
		: isDarkTheme
			? "dark"   // 否则根据用户选择的暗色主题决定
			: "light";
	// 获取应用更新检查功能
	const { checkUpdate, status, update } = useAppUpdate();
	const hasNotifiedRef = useRef(false);                              // 标记是否已通知更新
	const setSettingsOpen = useSetAtom(settingsDialogAtom);            // 设置对话框开关
	const setSettingsTab = useSetAtom(settingsTabAtom);                // 设置选项卡
	const initCustomBackgroundImage = useSetAtom(customBackgroundImageInitAtom); // 初始化自定义背景
	const { t } = useTranslation();                                    // 国际化翻译函数
	const store = useStore();                                          // Jotai 全局状态存储

	useEffect(() => {
		initCustomBackgroundImage();
	}, [initCustomBackgroundImage]);

	useEffect(() => {
		if (import.meta.env.TAURI_ENV_PLATFORM) {
			checkUpdate(true);
		}
	}, [checkUpdate]);

	useEffect(() => {
		if (status === "available" && update && !hasNotifiedRef.current) {
			hasNotifiedRef.current = true;

			toast.info(
				<div>
					<div style={{ fontWeight: "bold" }}>
						{t("app.update.updateAvailable", "发现新版本: {version}", {
							version: update.version,
						})}
					</div>
				</div>,
				{
					autoClose: 5000,
					onClick: () => {
						setSettingsTab("about");
						setSettingsOpen(true);
					},
				},
			);
		}
	}, [status, update, t, setSettingsOpen, setSettingsTab]);

	const setIsGlobalDragging = useSetAtom(isGlobalFileDraggingAtom);
	const { openFile } = useFileOpener();
	useAudioFeedback();

	useEffect(() => {
		if (!import.meta.env.TAURI_ENV_PLATFORM) {
			return;
		}

		(async () => {
			const file: {
				filename: string;
				data: string;
				ext: string;
			} | null = await invoke("get_open_file_data");

			if (file) {
				log("File data from tauri args", file);

				const fileObj = new File([file.data], file.filename, {
					type: "text/plain",
				});

				openFile(fileObj);
			}
		})();
	}, [openFile]);

	useEffect(() => {
		if (!import.meta.env.TAURI_ENV_PLATFORM) {
			return;
		}

		(async () => {
			const win = getCurrentWindow();
			if (platform() === "windows") {
				if (semverGt("10.0.22000", version())) {
					setHasBackground(true);
					await win.clearEffects();
				}
			}

			await new Promise((r) => requestAnimationFrame(r));

			await win.show();
		})();
	}, []);

	useEffect(() => {
		const onBeforeClose = (evt: BeforeUnloadEvent) => {
			const currentLyricLines = store.get(lyricLinesAtom);
			if (
				currentLyricLines.lyricLines.length +
					currentLyricLines.metadata.length >
				0
			) {
				evt.preventDefault();
				evt.returnValue = false;
			}
		};
		window.addEventListener("beforeunload", onBeforeClose);
		return () => {
			window.removeEventListener("beforeunload", onBeforeClose);
		};
	}, [store]);

	useEffect(() => {
		const handleDragEnter = (e: DragEvent) => {
			if (e.dataTransfer?.types.includes("Files")) {
				setIsGlobalDragging(true);
			}
		};

		const handleDragOver = (e: DragEvent) => {
			e.preventDefault();
		};

		const handleDragLeave = (e: DragEvent) => {
			if (e.relatedTarget === null) {
				setIsGlobalDragging(false);
			}
		};

		const handleDrop = (e: DragEvent) => {
			e.preventDefault();
			setIsGlobalDragging(false);

			const files = e.dataTransfer?.files;
			if (files && files.length > 0) {
				openFile(files[0]);
			}
		};

		window.addEventListener("dragenter", handleDragEnter);
		window.addEventListener("dragover", handleDragOver);
		window.addEventListener("dragleave", handleDragLeave);
		window.addEventListener("drop", handleDrop);

		return () => {
			window.removeEventListener("dragenter", handleDragEnter);
			window.removeEventListener("dragover", handleDragOver);
			window.removeEventListener("dragleave", handleDragLeave);
			window.removeEventListener("drop", handleDrop);
		};
	}, [setIsGlobalDragging, openFile]);

	return (
		<Theme
			appearance={effectiveTheme}
			panelBackground="solid"
			hasBackground={hasBackground}
			accentColor={effectiveTheme === "dark" ? "jade" : "green"}
			className={styles.radixTheme}
		>
			<ErrorBoundary
				FallbackComponent={AppErrorPage}
				onReset={(_details) => {
					// TODO
				}}
			>
				{customBackgroundImage && (
					<div className={styles.customBackgroundLayer} aria-hidden="true">
						<div
							className={styles.customBackgroundImage}
							style={{
								backgroundImage: `linear-gradient(rgba(0, 0, 0, ${customBackgroundMask}), rgba(0, 0, 0, ${customBackgroundMask})), url(${customBackgroundImage})`,
								opacity: customBackgroundOpacity,
								filter: `blur(${customBackgroundBlur}px) brightness(${customBackgroundBrightness})`,
							}}
						/>
					</div>
				)}
				<div className={styles.appContent}>
					<AutosaveManager />
					<GlobalDragOverlay />
					{toolMode === ToolMode.Sync && <SyncKeyBinding />}
					<DarkThemeDetector />
					<Flex direction="column" height="100vh">
						<TitleBar />
						<RibbonBar />
						<Box flexGrow="1" overflow="hidden">
							<AnimatePresence mode="wait">
								{toolMode !== ToolMode.Preview && (
									<SuspensePlaceHolder key="edit">
										<motion.div
											layout="position"
											style={{
												height: "100%",
												maxHeight: "100%",
												overflowY: "hidden",
											}}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0 }}
										>
											<LyricLinesView key="edit" />
										</motion.div>
									</SuspensePlaceHolder>
								)}
								{toolMode === ToolMode.Preview && (
									<SuspensePlaceHolder key="amll-preview">
										<Box height="100%" key="amll-preview" p="2" asChild>
											<motion.div
												layout="position"
												initial={{ opacity: 0 }}
												animate={{ opacity: 1 }}
												exit={{ opacity: 0 }}
											>
												<AMLLWrapper />
											</motion.div>
										</Box>
									</SuspensePlaceHolder>
								)}
							</AnimatePresence>
						</Box>
						{showTouchSyncPanel && toolMode === ToolMode.Sync && (
							<TouchSyncPanel />
						)}
						<Box flexShrink="0">
							<AudioControls />
						</Box>
					</Flex>
					<Suspense fallback={null}>
						<Dialogs />
					</Suspense>
					<ToastContainer theme={effectiveTheme} />
				</div>
			</ErrorBoundary>
		</Theme>
	);
}

export default App;