import { describe, expect, test } from 'bun:test'
import {
  BUYER_SOLD_NOTE,
  buyerStatusNote,
  SELLER_SOLD_NOTE,
} from '../src/features/listing/status-mark'
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

const PAGE = new URL('../src/pkg-browse/pages/listing-detail/index.tsx', import.meta.url)
const PC_PAGE = new URL('../../web-pc/src/features/listing-detail/detail-page.tsx', import.meta.url)

/** 买家操作钮那一支的收藏心：模板字符串形态，与买家「已售出」支里的 `is-on` 常量形态不同 */
const FALLBACK_FAV = 'className={`detail__fav${faved ?'

/** 在页面源码里从 `from` 起切到其后第一个 `to` 之前；锚点缺失一律抛（不许退化成窗口） */
function sliceOf(code: string, from: string, to: string): string {
  const begin = code.indexOf(from)
  expect(begin, `缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const finish = code.indexOf(to, begin + from.length)
  expect(finish, `缺少片段：${to}`).toBeGreaterThan(begin)
  return code.slice(begin + from.length, finish)
}

describe('buyerStatusNote —— 买家侧底栏状态行（#567）', () => {
  test('已售出：两套口吻同源同模块，人称不同是一开始就说清的语境区分', () => {
    // 卖家看自己的商品说「商品已售出」，买家看别人的说「此商品已售出」——
    // 两份字面量都在 `features/listing/status-mark`，不许各自散落在页面里
    expect(buyerStatusNote('SOLD')).toBe(BUYER_SOLD_NOTE)
    expect(ownerStatusNote('SOLD')).toBe(SELLER_SOLD_NOTE)
    expect(SELLER_SOLD_NOTE).not.toBe(BUYER_SOLD_NOTE)
  })

  test('在售 / 等面交不给状态行，底部栏照常渲染操作钮', () => {
    expect(buyerStatusNote('ACTIVE')).toBeNull()
    // RESERVED 仍在售卖流程里（有人拍下、还没成交），不当成一句话了事
    expect(buyerStatusNote('RESERVED')).toBeNull()
  })

  test('已下架在买家视角不可达：不出文案，而不是出了一条看不到的文案', () => {
    // 非卖家读 OFFLINE 商品的详情，服务端直接 404（不泄露存在性），买家到不了这一页。
    expect(buyerStatusNote('OFFLINE')).toBeNull()
  })
})

describe('页面接线', () => {
  test('演示登录钉死的账号只顶替「已登录」那一格，匿名态不许被顶成卖家', async () => {
    // 本页不挂登录守卫，`TARO_APP_MOCK=1` 的构建里退出登录后 `userId` 就是 `null`；
    // 少了 `userId !== null` 这一格，匿名访客会看到卖家底栏（`./view` 的
    // `isOwnListing` 单测只能证明函数本身，证明不了页面没有绕过它）
    const code = await Bun.file(PAGE).text()
    expect(code).toContain('DEMO_AUTH_ENABLED && userId !== null ? CURRENT_USER_ID : userId')
    // 常量必须来自叶子模块 `@/lib/demo-user-id`：改成从 `@/mock/users` 取（历史写法
    // 是 `ME as mockMe`）会把整份 `USERS` fixture 拖进生产包 —— 包体守卫在
    // `tests/mock-boundary.test.ts`，这里只钉住本页的接线。
    expect(code).toContain("from '@/lib/demo-user-id'")
    expect(code).not.toContain("from '@/mock/users'")
  })

  test('买家形态：已售出时底栏只留状态行，操作钮一个都不渲染（#567）', async () => {
    const code = await Bun.file(PAGE).text()
    // 判据取自 `features/listing/status-mark`（与卡片角标同一文件），页面里不许再手写这份文案
    // —— 判据本身也要钉死：把守卫改成 `&& false` 会让功能整条失效，只断言「函数名出现过」看不出来
    expect(code).toContain(
      'const buyerNote = data !== null && !ownListing ? buyerStatusNote(data.listing.status) : null',
    )
    expect(code).not.toContain(BUYER_SOLD_NOTE)

    // 切出**买家已售出这一支的支体**（到买家操作钮那支的收藏心为止），再断言里面有什么
    const buyerBranch = sliceOf(code, ') : buyerNote !== null ? (', FALLBACK_FAV)
    expect(buyerBranch).not.toBe('')
    expect(buyerBranch).toContain('{buyerNote}')
    // 点下去必失败的三个钮一个都不许留在这一支里
    expect(buyerBranch).not.toContain('立即购买')
    expect(buyerBranch).not.toContain('聊一聊')
    expect(buyerBranch).not.toContain('openBuy')
    expect(buyerBranch).not.toContain('chatWithSeller')
    // 但已收藏的人要能取消收藏（DELETE 不判商品状态），心形必须**只在已收藏时**出现：
    // POST 收藏对非 ACTIVE 商品必失败，所以未收藏时不给
    const favGate = sliceOf(buyerBranch, '{faved ? (', ') : null}')
    expect(favGate).toContain('detail__fav is-on')
    expect(favGate).toContain('onClick={toggleFavorite}')

    // 分支先后：卖家两档在前、买家已售出居中、买家操作钮最后 —— 顺序错了这一支就成死代码
    const sellerBranch = code.indexOf('{ownListing && ownerNote === null ? (')
    const sellerNoteBranch = code.indexOf(') : ownListing && ownerNote !== null ? (')
    const buyerNoteBranch = code.indexOf(') : buyerNote !== null ? (')
    const fallback = code.indexOf(FALLBACK_FAV)
    expect(sellerBranch).toBeGreaterThanOrEqual(0)
    expect(sellerBranch).toBeLessThan(sellerNoteBranch)
    expect(sellerNoteBranch).toBeLessThan(buyerNoteBranch)
    expect(buyerNoteBranch).toBeLessThan(fallback)
  })

  test('PC 详情页与小程序说同一句（跨端无共享模块，靠这条钉住不许漂）', async () => {
    const pc = await Bun.file(PC_PAGE).text()
    // PC 站不能 import 小程序的 `status-mark`，字面量只能照抄 —— 于是用一致性用例把两份钉在一起
    expect(pc).toContain(`'${BUYER_SOLD_NOTE}'`)
    expect(pc).toContain("item.status === 'SOLD'")
  })
})
