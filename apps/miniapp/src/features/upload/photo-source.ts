/**
 * 取图来源（纯逻辑，不 import Taro）。
 *
 * Owner 2026-09-29 定版：**拍摄不再走微信原生面板** —— 识图入口页自己开着相机（真取景 +
 * 快门），原生面板留给另外两个拿不到的画面来源：
 *
 * | 来源 | 原生 API | 面板 |
 * | --- | --- | --- |
 * | `album` | `chooseMedia({ sourceType: ['album'] })` | 系统相册（`compressed` 压过再给） |
 * | `chat` | `chooseMessageFile({ type: 'image' })` | 微信会话文件选择器 |
 *
 * 两个来源在识图入口页各有一个直点的按钮（不弹窗），在搜索页 / 结果页「换图」这类
 * 没有相机的地方则合成一个两项弹窗 —— 弹窗项与 `tapIndex` 的映射就是这里的纯逻辑。
 */

/** 弹窗项。数组顺序就是 `tapIndex` 的顺序。 */
export const PHOTO_SOURCE_OPTIONS = ['从相册选择', '从聊天会话选择'] as const

export type PhotoSource = 'album' | 'chat'

/**
 * `showActionSheet` 的 `tapIndex` → 来源。
 *
 * 越界返回 `null`（用户点取消时 `showActionSheet` 以 reject 收场、根本不会走到这里），
 * 与「用户取消」同一处置：什么都不做，不抛错。
 */
export function photoSourceFromTapIndex(tapIndex: number): PhotoSource | null {
  if (tapIndex === 0) return 'album'
  if (tapIndex === 1) return 'chat'
  return null
}

/** 来源的中文名（按钮文案与无障碍标签共用一处） */
export const PHOTO_SOURCE_LABEL: Record<PhotoSource, string> = {
  album: '相册',
  chat: '聊天记录',
}
