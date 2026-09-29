/**
 * 取图来源：微信原生弹窗（`showActionSheet`）的三个选项（纯逻辑，不 import Taro）。
 *
 * 为什么不用 `chooseMedia` 自己的原生面板：那个面板只有「拍摄 / 相册」两项，而 Owner
 * 2026-09-29 定版要求第三个来源「从聊天会话选择」（`chooseMessageFile`）。两个都是
 * 系统面板，没有一次调用能同时给出三种来源 —— 所以先弹 actionSheet 收来源，再按来源
 * 调对应的原生 API（见 `./api` 的 `pickPhotoFromSource`）。
 *
 * 抽成纯函数：`tapIndex → 来源` 是弹窗与取图之间的契约，写错只会表现为「点了拍摄却打开
 * 相册」这类静默错配，端上很难一眼看出，必须可单测。
 */

/** 弹窗项。数组顺序就是 `tapIndex` 的顺序，改顺序等于改用户看到的第一项。 */
export const PHOTO_SOURCE_OPTIONS = ['拍摄', '从相册选择', '从聊天会话选择'] as const

/** 三种取图来源：相机 / 相册 / 聊天会话 */
export type PhotoSource = 'camera' | 'album' | 'chat'

/**
 * `showActionSheet` 的 `tapIndex` → 来源。
 *
 * 越界返回 `null`（用户点了取消时 `showActionSheet` 以 reject 收场、根本不会走到这里，
 * 所以越界理论上不可达）—— 不抛错是因为「来源不明」与「用户取消」对调用方是同一处置：
 * 什么都不做。抛错会让一次平台抖动变成用户可见的报错。
 */
export function photoSourceFromTapIndex(tapIndex: number): PhotoSource | null {
  if (tapIndex === 0) return 'camera'
  if (tapIndex === 1) return 'album'
  if (tapIndex === 2) return 'chat'
  return null
}
