import { describe, expect, test } from 'bun:test'
import {
  createImageReloadState,
  IMAGE_RELOAD_MAX,
  noteImageFailure,
} from '../src/features/transaction/image-reload'

/**
 * 评价配图签名 URL 失效后的补读判据（#485 审查第二轮）。
 *
 * 为什么不能只按 URL 去重：服务端每次重读都会**重新签发** URL（token 对 `(key, 过期秒)`
 * 确定性，而过期秒每次都不同），所以「这个地址补过了」在下一轮不成立 —— 一张**永久**
 * 失败的图（对象被外部删掉）会 onError → 补读 → 新 URL → onError → 补读 …… 无界。
 * 只按 URL 去重的实现在这条用例下是红的（无限 true）。
 */
describe('noteImageFailure —— 同一 URL 不重复、总次数有上限', () => {
  test('第一次失败要补读，同一地址第二次不补（同一个签名不必再读一遍）', () => {
    const state = createImageReloadState()
    expect(noteImageFailure(state, 'https://api/u/1')).toBe(true)
    expect(noteImageFailure(state, 'https://api/u/1')).toBe(false)
  })

  test('重读换了一批签名（新地址）时还会补读，但总数到上限就停 —— 永久失败的图不会无界重读', () => {
    const state = createImageReloadState()
    // 每次重读都会拿到一个新签名，所以地址永远"没见过"；只有次数上限能拦住它
    for (let i = 0; i < IMAGE_RELOAD_MAX; i += 1) {
      expect(noteImageFailure(state, `https://api/u/${i}`)).toBe(true)
    }
    expect(noteImageFailure(state, 'https://api/u/fresh')).toBe(false)
    expect(state.count).toBe(IMAGE_RELOAD_MAX)
  })

  test('上限可注入（调用方要更保守时不必改常量）', () => {
    const state = createImageReloadState()
    expect(noteImageFailure(state, 'https://api/u/1', 1)).toBe(true)
    expect(noteImageFailure(state, 'https://api/u/2', 1)).toBe(false)
  })

  test('已补读过的地址在计数达上限后同样不再补（两个条件各自独立生效）', () => {
    const state = createImageReloadState()
    expect(noteImageFailure(state, 'https://api/u/1', 1)).toBe(true)
    expect(noteImageFailure(state, 'https://api/u/1', 1)).toBe(false)
    expect(state.attempted.has('https://api/u/1')).toBe(true)
  })
})
