import { beforeEach, describe, expect, test } from 'bun:test'
import { bindVisualShot, readVisualShot, stashVisualShot } from '@/features/visual-search/handoff'

/**
 * 「原图 + 取框」从识图入口页交给结果页的交接位（Owner 2026-09-30：共享元素式切换）。
 *
 * 两条不变量，写错了端上都很难看出来：
 * 1. **按 objectKey 读**：换了图（键对不上）必须拿到 `null` —— 否则结果页背景会显示
 *    **上一张照片**，比没有背景更糟；
 * 2. **重复读拿到同一份**：`useMemo` 的初始化在开发态可能跑两次，取一次就清空会让
 *    「背景时有时无」。
 */
const CROP = { x: 10, y: 20, w: 100, h: 120 }
const SHOT = { path: '/tmp/shot.jpg', width: 3000, height: 4000, crop: CROP }

beforeEach(() => {
  // 每个用例从干净状态开始：把可能残留的交接读掉（键必然对不上时会自清）
  readVisualShot('__reset__')
})

describe('readVisualShot —— 按 objectKey 取', () => {
  test('绑定之后能取到同一份，且可重复取（开发态重复渲染）', () => {
    stashVisualShot(SHOT)
    bindVisualShot('visual-search/a/b.jpg')
    const first = readVisualShot('visual-search/a/b.jpg')
    const second = readVisualShot('visual-search/a/b.jpg')
    expect(first).toEqual({ ...SHOT, objectKey: 'visual-search/a/b.jpg' })
    expect(second).toEqual(first)
  })

  test('键对不上：返回 null 并把残留清掉（不会把上一张照片当背景）', () => {
    stashVisualShot(SHOT)
    bindVisualShot('visual-search/a/b.jpg')
    expect(readVisualShot('visual-search/OTHER/c.jpg')).toBeNull()
    // 已清掉：连原来那个键也读不到了
    expect(readVisualShot('visual-search/a/b.jpg')).toBeNull()
  })

  test('还没 bind（上传没回来）：读不到', () => {
    stashVisualShot(SHOT)
    expect(readVisualShot('visual-search/a/b.jpg')).toBeNull()
  })

  test('空 objectKey（参数丢了）不返回任何东西', () => {
    stashVisualShot(SHOT)
    bindVisualShot('visual-search/a/b.jpg')
    expect(readVisualShot('')).toBeNull()
  })

  test('没有 stash 过：读不到', () => {
    expect(readVisualShot('visual-search/a/b.jpg')).toBeNull()
  })

  test('bind 之前没 stash：bind 不凭空造一份', () => {
    bindVisualShot('visual-search/a/b.jpg')
    expect(readVisualShot('visual-search/a/b.jpg')).toBeNull()
  })

  test('第二次识图覆盖第一次（同一键也不会读到旧图）', () => {
    stashVisualShot(SHOT)
    bindVisualShot('visual-search/a/one.jpg')
    stashVisualShot({ ...SHOT, path: '/tmp/second.jpg' })
    bindVisualShot('visual-search/a/two.jpg')
    expect(readVisualShot('visual-search/a/two.jpg')?.path).toBe('/tmp/second.jpg')
    // 第一次的键已经读不到了（残留是第二次那份）
    expect(readVisualShot('visual-search/a/one.jpg')).toBeNull()
  })
})
