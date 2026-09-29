import { describe, expect, test } from 'bun:test'
import { PHOTO_SOURCE_OPTIONS, photoSourceFromTapIndex } from '@/features/upload/photo-source'

/**
 * 取图来源弹窗（Owner 2026-09-29 定版）：拍摄 / 从相册选择 / 从聊天会话选择。
 *
 * 弹窗项的顺序就是 `tapIndex` 的顺序，而 `tapIndex → 来源` 是弹窗与取图之间的契约 ——
 * 写错只会表现为「点了拍摄却打开相册」这类静默错配（端上看不出来是 bug，只觉得怪）。
 * 所以三项与越界行为都在这里钉住。
 */
describe('PHOTO_SOURCE_OPTIONS', () => {
  test('三项文案与顺序（改顺序等于改用户点到的来源）', () => {
    expect([...PHOTO_SOURCE_OPTIONS]).toEqual(['拍摄', '从相册选择', '从聊天会话选择'])
  })
})

describe('photoSourceFromTapIndex', () => {
  test('三个下标各对应自己的来源', () => {
    expect(photoSourceFromTapIndex(0)).toBe('camera')
    expect(photoSourceFromTapIndex(1)).toBe('album')
    expect(photoSourceFromTapIndex(2)).toBe('chat')
  })

  test('越界返回 null（与「用户取消」同一处置：什么都不做）', () => {
    expect(photoSourceFromTapIndex(-1)).toBeNull()
    expect(photoSourceFromTapIndex(3)).toBeNull()
    expect(photoSourceFromTapIndex(99)).toBeNull()
  })
})
