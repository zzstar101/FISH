import { describe, expect, test } from 'bun:test'
import {
  createImageReloadState,
  finishImageReload,
  IMAGE_RELOAD_MAX,
  noteImageFailure,
} from '../src/features/transaction/image-reload'

/**
 * 评价配图签名 URL 失效后的补读闸门（#485 审查第二、三、四轮）。
 *
 * 为什么不能只按 URL 去重：服务端每次重读都会**重新签发** URL（token 对 `(key, 过期秒)`
 * 确定性，而过期秒每次都不同），所以「这个地址补过了」在下一轮不成立 —— 一张**永久**
 * 失败的图（对象被外部删掉）会 onError → 补读 → 新 URL → onError → 补读 …… 无界。
 *
 * 第三轮（审查 P2）补的：整屏缩略图一起过期是常态，所以
 * - **一批只跑一个补读周期**：同一批里第二、三张图失败时 `noteImageFailure` 必须回 `false`
 *   （并入在飞的那次）。旧实现各发一次首屏读：并发三次、一次吃满三份预算，
 *   还会互相顶掉对方的落地（调用方按代次丢弃迟到响应）；
 * - **预算按批次算**：三张图一起过期是一批，只花一份预算。
 *
 * 第四轮（独立审查 P3）补的：**失败不留后患**。
 * - 并入在飞的地址**不记** `attempted`：那一批失败后它们要能各自触发后续批次；
 * - `finishImageReload(state, false)` 把本批触发地址从 `attempted` 撤掉，
 *   否则「一次补读失败」会被记成「这些图补过了」，在本页实例里永远不再自动补；
 * - 但**批次计数不回退** —— 单调递增才是「永久失败的图不会无界重读」的那道闸。
 */
describe('noteImageFailure —— 一批一个周期、同一 URL 不重复、批次有上限', () => {
  test('第一次失败要补读；同一地址第二次不补（同一个签名不必再读一遍）', () => {
    const state = createImageReloadState()
    expect(noteImageFailure(state, 'https://api/u/1')).toBe(true)
    finishImageReload(state, true)
    expect(noteImageFailure(state, 'https://api/u/1')).toBe(false)
  })

  test('同一批里其余图失败时并入在飞的那次，不再另发请求', () => {
    const state = createImageReloadState()
    expect(noteImageFailure(state, 'https://api/u/1')).toBe(true)
    // 整屏缩略图同时裂开：第 2、3 张落进同一个补读窗口
    expect(noteImageFailure(state, 'https://api/u/2')).toBe(false)
    expect(noteImageFailure(state, 'https://api/u/3')).toBe(false)
    // 三张图只花掉一份预算
    expect(state.count).toBe(1)
  })

  test('补读落地后释放闸门，下一批（新签名地址）还能补', () => {
    const state = createImageReloadState()
    expect(noteImageFailure(state, 'https://api/u/1')).toBe(true)
    expect(noteImageFailure(state, 'https://api/u/2')).toBe(false)
    finishImageReload(state, true)
    // 服务端重读换了一批签名：地址没见过，闸门也开着 → 补
    expect(noteImageFailure(state, 'https://api/u/1-new')).toBe(true)
    expect(state.count).toBe(2)
  })

  test('重读换了一批签名（新地址）时还会补读，但批次到上限就停 —— 永久失败的图不会无界重读', () => {
    const state = createImageReloadState()
    for (let i = 0; i < IMAGE_RELOAD_MAX; i += 1) {
      expect(noteImageFailure(state, `https://api/u/${i}`)).toBe(true)
      finishImageReload(state, true)
    }
    expect(noteImageFailure(state, 'https://api/u/fresh')).toBe(false)
    expect(state.count).toBe(IMAGE_RELOAD_MAX)
  })

  test('上限可注入（调用方要更保守时不必改常量）', () => {
    const state = createImageReloadState()
    expect(noteImageFailure(state, 'https://api/u/1', 1)).toBe(true)
    finishImageReload(state, true)
    expect(noteImageFailure(state, 'https://api/u/2', 1)).toBe(false)
  })
})

describe('finishImageReload —— 失败不留后患', () => {
  test('批次成功：触发地址留在 attempted 里，同一地址不再补', () => {
    const state = createImageReloadState()
    expect(noteImageFailure(state, 'https://api/u/1')).toBe(true)
    finishImageReload(state, true)
    expect(state.attempted.has('https://api/u/1')).toBe(true)
    expect(state.inFlightUrl).toBeNull()
  })

  test('批次失败：触发地址被撤掉，同一地址还能再补（但批次计数不回退）', () => {
    const state = createImageReloadState()
    expect(noteImageFailure(state, 'https://api/u/1')).toBe(true)
    finishImageReload(state, false)
    expect(state.attempted.has('https://api/u/1')).toBe(false)
    expect(state.inFlightUrl).toBeNull()
    // 还能再试 —— 否则「断网一次」= 这页的图在本实例里永远不再自动补
    expect(noteImageFailure(state, 'https://api/u/1')).toBe(true)
    // 但计数是单调的：重试不会重置无界重读的闸门
    expect(state.count).toBe(2)
  })

  test('并入在飞的地址不进 attempted：那一批失败后它们各自还能触发后续批次', () => {
    const state = createImageReloadState()
    expect(noteImageFailure(state, 'https://api/u/1')).toBe(true)
    expect(noteImageFailure(state, 'https://api/u/2')).toBe(false)
    expect(state.attempted.has('https://api/u/2')).toBe(false)
    finishImageReload(state, false)
    // u2 从没发起过补读，失败后自然还能自己起一批
    expect(noteImageFailure(state, 'https://api/u/2')).toBe(true)
    expect(state.count).toBe(2)
  })

  test('永久失败的图仍被批次上限挡住（撤 attempted 不等于放开无界重读）', () => {
    const state = createImageReloadState()
    // 每次都换新签名（地址永远没见过）+ 每次请求都失败 → 只有批次计数能拦住
    for (let i = 0; i < IMAGE_RELOAD_MAX; i += 1) {
      expect(noteImageFailure(state, `https://api/u/${i}`)).toBe(true)
      finishImageReload(state, false)
    }
    expect(noteImageFailure(state, 'https://api/u/never')).toBe(false)
  })
})
