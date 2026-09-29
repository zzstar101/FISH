import { describe, expect, test } from 'bun:test'
import {
  PHOTO_SOURCE_LABEL,
  PHOTO_SOURCE_OPTIONS,
  photoSourceFromTapIndex,
} from '@/features/upload/photo-source'

/**
 * 取图来源弹窗（Owner 2026-09-29 定版）：**只剩两项** —— 从相册选择 / 从聊天会话选择。
 *
 * 「拍摄」已从原生面板移除：识图入口页自己开着相机、自己出快门，原生面板里再放一个
 * 「拍摄」就是同一个能力两条路。所以这里同时钉住「没有拍摄这一项」—— 谁把它加回来，
 * 这条用例会先红。
 *
 * 弹窗项的顺序就是 `tapIndex` 的顺序，而 `tapIndex → 来源` 是弹窗与取图之间的契约 ——
 * 写错只会表现为「点了相册却打开聊天记录」这类静默错配（端上看不出来是 bug，只觉得怪）。
 */
describe('PHOTO_SOURCE_OPTIONS', () => {
  test('两项文案与顺序（改顺序等于改用户点到的来源）', () => {
    expect([...PHOTO_SOURCE_OPTIONS]).toEqual(['从相册选择', '从聊天会话选择'])
  })

  test('不再提供「拍摄」来源', () => {
    expect([...PHOTO_SOURCE_OPTIONS]).not.toContain('拍摄')
  })
})

describe('photoSourceFromTapIndex', () => {
  test('两个下标各对应自己的来源', () => {
    expect(photoSourceFromTapIndex(0)).toBe('album')
    expect(photoSourceFromTapIndex(1)).toBe('chat')
  })

  test('越界返回 null（与「用户取消」同一处置：什么都不做）', () => {
    expect(photoSourceFromTapIndex(-1)).toBeNull()
    expect(photoSourceFromTapIndex(2)).toBeNull()
    expect(photoSourceFromTapIndex(99)).toBeNull()
  })
})

describe('PHOTO_SOURCE_LABEL', () => {
  test('两个来源都有中文名（按钮文案与无障碍标签共用）', () => {
    expect(PHOTO_SOURCE_LABEL).toEqual({ album: '相册', chat: '聊天记录' })
  })
})
