import { describe, expect, mock, test } from 'bun:test'

/**
 * 争议详情页的在途操作身份（#497 复查：账号隔离缺口）。
 *
 * 页面里每一个异步动线（撤回 / 补附件 / 加证据 / 读候选消息 / 翻更早 / 预览大图）都在
 * `await` 之后写状态或再发请求。旧实现这几处只看 `alive`（页面还挂着），会话替换时页面可能尚未卸载
 * ——上一账号的响应照样回写到新账号的界面上；上传链更是把「抓身份」放在 `pickPhotos` 之后，
 * 选图期间换号就会用新账号的会话继续处理旧争议。
 *
 * 判定抽成 `opAliveIn` / `opWritableIn` 两个纯函数（页面模块顶层，不依赖 Taro 运行时）：
 * 兼容的浏览器/小程序端没有组件渲染基建，只有纯函数能在 bun 里逐条钉住。
 */

Object.assign(globalThis, { __ALLOW_MOCK_FALLBACK__: false, __DEMO_AUTH__: false })

// 页面模块只用到 Taro 的运行时 API 与四个基础组件；判据是纯函数，不做真渲染。
mock.module('@tarojs/components', () => ({
  Image: 'img',
  ScrollView: 'div',
  Text: 'span',
  View: 'div',
}))
mock.module('@tarojs/taro', () => ({
  default: {
    showToast: async () => {},
    showModal: async () => ({ confirm: false }),
    previewImage: async () => {},
    navigateTo: async () => {},
  },
  useDidShow: () => {},
  useRouter: () => ({ params: {} }),
}))

const { opAliveIn, opWritableIn, opOwnsBusyIn } = await import(
  '../src/pkg-trade/pages/dispute-detail/index'
)

const OP = { userId: 'usr_a', disputeId: 'dsp_1', epoch: 7, ownerEpoch: 1 }
/** 发起那一刻的页面身份：同账号、同争议、同世代、争议仍待处理 */
const NOW = {
  alive: true,
  epoch: 7,
  ownerEpoch: 1,
  userId: 'usr_a',
  disputeId: 'dsp_1',
  status: 'PENDING' as const,
}

describe('opAliveIn —— 这次异步操作还属不属于当前页面', () => {
  test('账号 / 争议 / 世代都对得上 → 可以写回', () => {
    expect(opAliveIn(OP, NOW)).toBe(true)
  })

  test('换号：旧账号的响应不能写进新账号的页面', () => {
    // 会话替换、尚未卸载时，`alive` 还是 true —— 只看 `alive` 的旧实现会照样回写。
    // 换号那一刻还会清空 `detail` 并起一个新世代，两个判据都必须挡住。
    expect(opAliveIn(OP, { ...NOW, userId: 'usr_b' })).toBe(false)
    expect(
      opAliveIn(OP, { ...NOW, userId: 'usr_b', disputeId: null, status: null, epoch: 8 }),
    ).toBe(false)
  })

  test('页面已卸载 → 什么都不写', () => {
    expect(opAliveIn(OP, { ...NOW, alive: false })).toBe(false)
  })

  test('同号的静默刷新（世代 +1）→ 写回作废，等刷新结果说话', () => {
    expect(opAliveIn(OP, { ...NOW, epoch: 8 })).toBe(false)
  })

  test('手上已是另一条争议（或还没读到）→ 写回作废', () => {
    expect(opAliveIn(OP, { ...NOW, disputeId: 'dsp_2' })).toBe(false)
    expect(opAliveIn(OP, { ...NOW, disputeId: null, status: null })).toBe(false)
  })
})

describe('忙位只归同一次账号进入所有', () => {
  test('同号静默刷新后仍能收尾，但 A→B→A 的旧链不能清新忙位', () => {
    expect(opOwnsBusyIn(OP, { ...NOW, epoch: 8 })).toBe(true)
    expect(opOwnsBusyIn(OP, { ...NOW, epoch: 9, ownerEpoch: 3 })).toBe(false)
    expect(opOwnsBusyIn(OP, { ...NOW, alive: false })).toBe(false)
  })
})

describe('opWritableIn —— 上传链每一步的补材料资格', () => {
  test('发起时与此刻都还是 PENDING → 可以继续 presign / PUT / confirm', () => {
    expect(opWritableIn(OP, NOW)).toBe(true)
  })

  test('上传期间争议被撤回或处理完 → 不再 confirm', () => {
    expect(opWritableIn(OP, { ...NOW, status: 'WITHDRAWN' })).toBe(false)
    expect(opWritableIn(OP, { ...NOW, status: 'RESOLVED' })).toBe(false)
  })

  test('换号后即使争议还是 PENDING 也不写', () => {
    expect(opWritableIn(OP, { ...NOW, userId: 'usr_b' })).toBe(false)
  })

  test('页面卸载 / 世代变化同样不够格', () => {
    expect(opWritableIn(OP, { ...NOW, alive: false })).toBe(false)
    expect(opWritableIn(OP, { ...NOW, epoch: 8 })).toBe(false)
  })
})
