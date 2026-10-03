import { describe, expect, test } from 'bun:test'
import {
  clearedPrivateScope,
  isOwnListing,
  ownerStatusNote,
} from '../src/pkg-browse/pages/listing-detail/view'

/**
 * 商品详情页卖家 / 买家视角底栏的判据（Owner 2026-09-27 拍板的视角拆分）。
 *
 * 这里只回归纯逻辑：归属判断、非在售状态行、下架卡的清场初值。渲染接线
 * （底栏三形态的切换、确认卡三态按钮）按 `docs/miniapp-dev-workflow.md` §5
 * 在微信开发者工具里实测 —— 本页没有渲染测试基建，与 `listing-detail-lifecycle`
 * 的分工相同。
 */
describe('isOwnListing', () => {
  test('sellerId 与当前用户一致时是卖家视角', () => {
    expect(isOwnListing('u-1', 'u-1')).toBe(true)
  })

  test('匿名（userId = null）永远是买家形态', () => {
    expect(isOwnListing('u-1', null)).toBe(false)
  })

  test('别人看的商品不是卖家视角', () => {
    expect(isOwnListing('u-1', 'u-2')).toBe(false)
  })

  test('列表卡的 NO_SELLER 空串哨兵不会撞出卖家视角', () => {
    // 哨兵是空串：只要当前账号也是空串（`MeSchema.id` 是 uuid，正常到不了），
    // 等值比较就会把「没有卖家」判成「我就是卖家」—— 所以 `userId !== null` 不够，
    // 空串本身也必须判否
    expect(isOwnListing('', 'u-1')).toBe(false)
    expect(isOwnListing('', '')).toBe(false)
  })
})

describe('ownerStatusNote', () => {
  test('在售没有状态行，渲染「管理 / 看谁想要」', () => {
    expect(ownerStatusNote('ACTIVE')).toBeNull()
  })

  test('已下架 / 已售出 / 等面交各有状态行（口径同我的发布页）', () => {
    expect(ownerStatusNote('OFFLINE')).toBe('商品已下架')
    expect(ownerStatusNote('SOLD')).toBe('商品已售出')
    expect(ownerStatusNote('RESERVED')).toBe('已同意 · 等面交')
  })

  test('审核态与治理标记改口径：不能再把审核中 / 不过审 / 平台下架都说成「商品已下架」', () => {
    /*
     * 「我的发布」在 2026-09-28 给审核阶段单开了一段，卖家从那里点进详情时
     * 底栏若还写「商品已下架」，同一件商品在两屏给出两个结论。
     */
    expect(ownerStatusNote('OFFLINE', 'REVIEW')).toBe('商品审核中')
    expect(ownerStatusNote('OFFLINE', 'BLOCKED')).toBe('商品审核未通过')
    expect(ownerStatusNote('OFFLINE', null, true)).toBe('商品已被平台下架')
    // 治理下架在库里也是 BLOCKED，标记优先 —— 否则平台下架会被说成「内容没过审」
    expect(ownerStatusNote('OFFLINE', 'BLOCKED', true)).toBe('商品已被平台下架')
    // 审核态对**非 OFFLINE** 的商品不参与：已售出就是已售出
    expect(ownerStatusNote('SOLD', 'REVIEW')).toBe('商品已售出')
  })
})

describe('下架确认卡是账号私有的', () => {
  test('换号清场把确认卡关掉、请求三态复位', () => {
    const cleared = clearedPrivateScope()
    expect(cleared.offlineConfirmOpen).toBe(false)
    expect(cleared.offlineSubmit).toBe('idle')
  })
})

describe('页面接线', () => {
  test('演示登录钉死的账号只顶替「已登录」那一格，匿名态不许被顶成卖家', async () => {
    // 本页不挂登录守卫，`TARO_APP_MOCK=1` 的构建里退出登录后 `userId` 就是 `null`；
    // 少了 `userId !== null` 这一格，匿名访客会看到卖家底栏（`./view` 的
    // `isOwnListing` 单测只能证明函数本身，证明不了页面没有绕过它）
    const code = await Bun.file(
      new URL('../src/pkg-browse/pages/listing-detail/index.tsx', import.meta.url),
    ).text()
    expect(code).toContain('DEMO_AUTH_ENABLED && userId !== null ? mockMe.id : userId')
  })
})
