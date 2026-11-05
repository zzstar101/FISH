import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { PublicUserProfile } from '@fish/contracts/users/schema'
import * as React from 'react'
import type { MockListing } from '@/mock/types'

/**
 * 他人主页「分段取数失败」的**行为回归**（#598 验收 (e)）。
 *
 * 场景：注入某一段取数失败 → 切到另一段 → 切回来仍显示**段内失败**（不是空态、不是骨架）
 * → 点列表里那颗「重试」成功恢复。
 *
 * 为什么不能只做源码字符串断言（`tests/user-page-tabs.test.ts` 里 #598 那几条的做法）：
 * 这一串行为横跨三处 —— `loadSegment` 的 catch、`switchSegment` 的整份重置、
 * `shouldRefetch` 的「失败后不自动补拉」。字符串断言只能证明每句话还在文件里，
 * 证明不了**连着跑起来**还是这个结果：`failed` 被谁清掉、effect 反复重打同一段、
 * 失败分支被空态/骨架分支抢走，都能让源码文本全绿而端上表现全错。
 *
 * 本仓 `tests/` 没有组件渲染基建（见 `dispute-detail-identity.test.ts` 的说明），所以这里
 * 自带一个**只为跑这一个页面函数**的极简 hook 运行时：装上 React 18 的
 * `ReactCurrentDispatcher`，把 `useState` / `useEffect` / `useRef` / `useMemo` /
 * `useCallback` 接到一份可重渲染的 hook 表上，Taro 与页面级组件 mock 掉。跑起来的是
 * `pkg-browse/pages/user/index.tsx` 自己的闭包与状态机，断言读的是它会交给渲染层的
 * 那棵元素树 —— 不是源码文本。
 *
 * 不钉的东西：样式、滚动、`Taro` 原生 API 的真实行为（那些只能在开发者工具里看，
 * 见 `docs/miniapp-dev-workflow.md`）。
 */

/* ------------------------------------------------------------------ 数据形状 */

const PAGE_OWNER = 'usr_pageowner'

const PROFILE: PublicUserProfile = {
  id: PAGE_OWNER,
  nickname: '页主',
  avatarUrl: null,
  authStatus: 'VERIFIED',
  signature: null,
  joinedDays: 30,
  activeCount: 1,
  soldCount: 1,
  presence: { online: false, lastActiveAt: null },
}

const listing = (id: string, title: string, status: 'ACTIVE' | 'SOLD'): MockListing => ({
  id,
  title,
  priceCents: 1200,
  originalPriceCents: null,
  category: 'DIGITAL',
  sub: '',
  condition: 'LIKE_NEW',
  status,
  urgent: false,
  negotiable: false,
  free: false,
  coverUrl: '',
  images: [],
  ratio: '1x1',
  badge: null,
  description: '',
  spec: '',
  sellerId: PAGE_OWNER,
  seller: null,
  views: null,
  wants: null,
})

type SegmentStatus = 'ACTIVE' | 'SOLD'
type ListingPage = { listings: MockListing[]; nextCursor: string | null }
type HomeResult =
  | { status: 'notFound' }
  | { status: 'failed' }
  | {
      status: 'ok'
      profile: PublicUserProfile
      listings: MockListing[]
      nextCursor: string | null
    }

/** 与 `features/request` 抛出的 `ApiError` 同形状（形状判别，见 `segment-page.ts`） */
function apiError(code: string, status: number): Error {
  return Object.assign(new Error(`${code} ${status}`), { name: 'ApiError', code, status })
}

/* ------------------------------------------------------- 极简 hook 运行时 */

/** 与 React 的 effect 回调同构：可以不返回，也可以返回一个清理函数 */
type EffectRun = () => unknown
type EffectCleanup = () => void

type EffectCell = {
  kind: 'effect'
  deps: unknown[] | null
  run: EffectRun
  cleanup: EffectCleanup | undefined
  pending: boolean
}
type StateCell = { kind: 'state'; value: unknown; set: (next: unknown) => void }
type RefCell = { kind: 'ref'; value: { current: unknown } }
type MemoCell = { kind: 'memo'; value: unknown; deps: unknown[] | null }
type HookCell = StateCell | RefCell | MemoCell | EffectCell

/** 单次挂载里最多重渲染多少趟：页面若在 setState 里自激，这里会响得很明显 */
const MAX_PASSES = 200

function depsChanged(prev: unknown[] | null, next: unknown[] | null): boolean {
  if (prev === null || next === null) return true
  if (prev.length !== next.length) return true
  return next.some((dep, i) => !Object.is(dep, prev[i]))
}

let active: MiniPage | null = null

function current(): MiniPage {
  if (active === null) throw new Error('hook 在页面渲染之外被调用')
  return active
}

/**
 * 一次页面挂载：持有 hook 表，`pass()` 就是「跑一遍页面函数 + 提交 effect」，
 * `settle()` 把异步链路（fetch → setState → 重渲染）跑到不动为止。
 */
class MiniPage {
  tree: unknown = null
  private readonly cells: HookCell[] = []
  private cursor = 0
  private passes = 0
  private rendering = false
  private dirty = false
  private scheduled = false
  /** 渲染里抛出来的错误：留到 `settle()` 里抛，别让它变成「测试之间的未处理异常」 */
  private failure: unknown = null

  constructor(private readonly run: () => unknown) {}

  mount(): this {
    active = this
    this.pass()
    return this
  }

  /** 等页面自己静下来（请求回来 / 重渲染 / effect 都跑完） */
  async settle(): Promise<void> {
    for (let i = 0; i < 80; i++) {
      const before = this.passes
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (this.failure !== null) throw this.failure
      if (this.passes === before && !this.dirty && !this.scheduled) return
    }
    if (this.failure !== null) throw this.failure
    throw new Error('页面没有静下来：settle 轮次用尽，可能在某处自激重渲染')
  }

  private pass(): void {
    this.passes += 1
    if (this.passes > MAX_PASSES) {
      throw new Error(`重渲染超过 ${MAX_PASSES} 趟：页面状态机没有收敛`)
    }
    this.cursor = 0
    this.rendering = true
    this.tree = this.run()
    for (const cell of this.cells) {
      if (cell.kind !== 'effect' || !cell.pending) continue
      cell.pending = false
      cell.cleanup?.()
      cell.cleanup = undefined
      const cleanup = cell.run()
      cell.cleanup = typeof cleanup === 'function' ? (cleanup as EffectCleanup) : undefined
    }
    this.rendering = false
    if (this.dirty) {
      this.dirty = false
      this.pass()
    }
  }

  /**
   * 一次 `setState` 之后的重渲染。
   *
   * 渲染中（effect 提交里）调的 setState 记成 dirty，本趟跑完再补一趟；渲染之外调的
   * setState **不重入渲染**，排到微任务里去 —— 这一点必须跟 React 一致：页面在
   * `try { await fetch } catch { setState(失败) } finally { inFlight = false }` 这种写法里
   * 靠 `setState` 之后才跑到 `finally`，同步重入渲染会让 `inFlight` 闩还锁着，
   * 把「会不会自动重打接口」这类真实行为整个掩盖掉。
   */
  private bump(): void {
    this.dirty = true
    if (this.rendering || this.scheduled || this.failure !== null) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.dirty || this.failure !== null) return
      this.dirty = false
      try {
        this.pass()
      } catch (error) {
        this.failure = error
      }
    })
  }

  useState(init: unknown): [unknown, (next: unknown) => void] {
    let cell = this.cells[this.cursor] as StateCell | undefined
    if (cell === undefined) {
      const created: StateCell = {
        kind: 'state',
        value: undefined,
        set: (next) => {
          const prev = created.value
          const value = typeof next === 'function' ? (next as (p: unknown) => unknown)(prev) : next
          if (Object.is(value, prev)) return
          created.value = value
          this.bump()
        },
      }
      created.value = typeof init === 'function' ? (init as () => unknown)() : init
      cell = created
      this.cells.push(created)
    }
    this.cursor += 1
    return [cell.value, cell.set]
  }

  useRef(init: unknown): { current: unknown } {
    let cell = this.cells[this.cursor] as RefCell | undefined
    if (cell === undefined) {
      cell = { kind: 'ref', value: { current: init } }
      this.cells.push(cell)
    }
    this.cursor += 1
    return cell.value
  }

  useMemo(fn: () => unknown, deps?: unknown[]): unknown {
    const next = deps ?? null
    let cell = this.cells[this.cursor] as MemoCell | undefined
    if (cell === undefined) {
      cell = { kind: 'memo', value: fn(), deps: next }
      this.cells.push(cell)
    } else if (depsChanged(cell.deps, next)) {
      cell.value = fn()
      cell.deps = next
    }
    this.cursor += 1
    return cell.value
  }

  useCallback(fn: unknown, deps?: unknown[]): unknown {
    return this.useMemo(() => fn, deps)
  }

  useEffect(run: EffectRun, deps?: unknown[]): void {
    const next = deps ?? null
    const cell = this.cells[this.cursor] as EffectCell | undefined
    if (cell === undefined) {
      this.cells.push({ kind: 'effect', deps: next, run, cleanup: undefined, pending: true })
    } else {
      cell.run = run
      if (depsChanged(cell.deps, next)) {
        cell.deps = next
        cell.pending = true
      }
    }
    this.cursor += 1
  }
}

type Dispatcher = {
  useState: (init: unknown) => [unknown, (next: unknown) => void]
  useRef: (init: unknown) => { current: unknown }
  useMemo: (fn: () => unknown, deps?: unknown[]) => unknown
  useCallback: (fn: unknown, deps?: unknown[]) => unknown
  useEffect: (run: EffectRun, deps?: unknown[]) => void
  useLayoutEffect: (run: EffectRun, deps?: unknown[]) => void
}

const dispatcher: Dispatcher = {
  useState: (init) => current().useState(init),
  useRef: (init) => current().useRef(init),
  useMemo: (fn, deps) => current().useMemo(fn, deps),
  useCallback: (fn, deps) => current().useCallback(fn, deps),
  useEffect: (run, deps) => current().useEffect(run, deps),
  useLayoutEffect: (run, deps) => current().useEffect(run, deps),
}

// React 18 的当前 dispatcher 槽位：装上去之后 `React.useState` 这些就走上面的表。
const reactInternals = React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
    ReactCurrentDispatcher: { current: Dispatcher | null }
  }
}
reactInternals.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current =
  dispatcher

/* ------------------------------------------------------------ 元素树读取 */

type RElement = { type: unknown; props: Record<string, unknown> }

function isElement(node: unknown): node is RElement {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node
}

/** 深度优先走一遍元素树（只走 `props.children`，不执行任何子组件） */
function eachElement(node: unknown, visit: (el: RElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) eachElement(child, visit)
    return
  }
  if (!isElement(node)) return
  visit(node)
  eachElement(node.props.children, visit)
}

function findAll(tree: unknown, match: (el: RElement) => boolean): RElement[] {
  const hits: RElement[] = []
  eachElement(tree, (el) => {
    if (match(el)) hits.push(el)
  })
  return hits
}

const classesOf = (el: RElement): string[] =>
  typeof el.props.className === 'string' ? el.props.className.split(/\s+/).filter(Boolean) : []

const hasClass = (cls: string) => (el: RElement) => classesOf(el).includes(cls)

const byClass = (tree: unknown, cls: string): RElement[] => findAll(tree, hasClass(cls))
const byType = (tree: unknown, type: string): RElement[] => findAll(tree, (el) => el.type === type)

/** 元素树上的可见文本（含数字子节点；不含 props 上的文案） */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join('')
  if (!isElement(node)) return ''
  return textOf(node.props.children)
}

/** 列表区那条「段内失败」空态（整页 `LoadError` 是另一回事，别混为一谈） */
function segmentFailure(tree: unknown): RElement | null {
  return byType(tree, 'EmptyState').find((el) => el.props.title === '列表加载失败') ?? null
}

/** 点页头「在售 / 卖出」两格里的一格 */
function clickSegment(tree: unknown, label: '在售' | '卖出'): void {
  const [cell] = findAll(
    tree,
    (el) => hasClass('uhome__stat--link')(el) && textOf(el).includes(label),
  )
  if (cell === undefined) throw new Error(`页头两格里找不到「${label}」那一格`)
  const onClick = cell.props.onClick
  if (typeof onClick !== 'function') throw new Error(`「${label}」那一格不可点`)
  onClick()
}

/* ---------------------------------------------------------------- 打桩 */

const routerParams: { id?: string; tab?: string } = {}
/** Taro `useLoad` 注册的回调（页面靠它发起首屏那一轮） */
const pendingLoads: Array<() => void> = []

const harness = {
  homeCalls: 0,
  segmentCalls: [] as SegmentStatus[],
  home: async (): Promise<HomeResult> => ({
    status: 'ok',
    profile: PROFILE,
    listings: [listing('lst_active_1', '在售商品', 'ACTIVE')],
    nextCursor: null,
  }),
  segment: async (status: SegmentStatus): Promise<ListingPage | null> => ({
    listings: [listing(`lst_${status.toLowerCase()}_1`, `${status} 商品`, status)],
    nextCursor: null,
  }),
}

mock.module('@tarojs/components', () => ({
  Image: 'Image',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
}))

mock.module('@tarojs/taro', () => {
  const query = {
    select: () => query,
    boundingClientRect: () => query,
    exec: (cb: (res: unknown[]) => void) => cb([]),
  }
  return {
    default: {
      navigateTo: async () => {},
      navigateBack: async () => {},
      showToast: async () => {},
      showModal: async () => ({ confirm: false }),
      nextTick: (cb: () => void) => cb(),
      createSelectorQuery: () => query,
      getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
      getMenuButtonBoundingClientRect: () => ({
        top: 48,
        left: 281,
        width: 87,
        height: 32,
        right: 368,
        bottom: 80,
      }),
      getSystemInfoSync: () => ({ windowWidth: 375, statusBarHeight: 44 }),
      pageScrollTo: async () => {},
    },
    useLoad: (cb: () => void) => {
      if (pendingLoads.length === 0) pendingLoads.push(cb)
    },
    useRouter: () => ({ params: routerParams }),
    useDidShow: () => {},
    useDidHide: () => {},
    useUnload: () => {},
  }
})

mock.module('@/features/fetchers', () => ({
  MOCK_FALLBACK_ENABLED: false,
  loadPublicUserHome: async () => {
    harness.homeCalls += 1
    return harness.home()
  },
  loadPublicUserListingsPage: async (
    _userId: string,
    status: SegmentStatus,
  ): Promise<ListingPage | null> => {
    harness.segmentCalls.push(status)
    return harness.segment(status)
  },
}))

// 本用例只跑匿名访客口径：关注 / 拉黑两块整块不渲染，接口一次都不该被打到。
mock.module('@/features/auth/store', () => ({ useAuth: () => ({ user: null }) }))
mock.module('@/features/blocks/api', () => ({
  fetchBlockState: async () => null,
  setBlock: async () => null,
}))
mock.module('@/features/following/api', () => ({
  fetchFollowState: async () => null,
  setFollow: async () => null,
}))
mock.module('@/lib/request', () => ({ isUnauthenticatedError: () => false }))
mock.module('@/features/presence/use-presence-now', () => ({
  usePresenceNow: () => 1_700_000_000_000,
}))

// 页面级组件换成标记名：断言读它们收到的 props（这是页面自己的决定），不去渲染实现。
mock.module('@/components/empty-state', () => ({ default: 'EmptyState' }))
mock.module('@/components/load-error', () => ({ default: 'LoadError' }))
mock.module('@/components/nav-bar', () => ({ default: 'NavBar' }))
mock.module('@/components/back-top', () => ({ default: 'BackTop', BACK_TOP_THRESHOLD: 320 }))

const { default: UserHome } = await import('../src/pkg-browse/pages/user/index')

// 这里会**故意**注入取数失败，页面会如实 console.error；静音它，同时留个可断言的记录
const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
afterEach(() => errorSpy.mockClear())

/* ---------------------------------------------------------------- 用例 */

describe('他人主页：分段取数失败后的切段与重试（#598 验收 (e)）', () => {
  beforeEach(() => {
    harness.homeCalls = 0
    harness.segmentCalls = []
    harness.home = async () => ({
      status: 'ok',
      profile: PROFILE,
      listings: [listing('lst_active_1', '在售商品', 'ACTIVE')],
      nextCursor: null,
    })
    harness.segment = async (status) => ({
      listings: [listing(`lst_${status.toLowerCase()}_1`, `${status} 商品`, status)],
      nextCursor: null,
    })
    pendingLoads.length = 0
    routerParams.id = PAGE_OWNER
    delete routerParams.tab
  })

  /** 挂载他人主页跑完首屏那一轮（`useLoad` → `load()`） */
  async function openUserPage(): Promise<MiniPage> {
    const page = new MiniPage(() => UserHome())
    page.mount()
    const load = pendingLoads.shift()
    load?.()
    await page.settle()
    return page
  }

  test('注入 5xx → 切段 → 切回仍是段内失败（不是空态 / 骨架）→ 点重试恢复', async () => {
    const page = await openUserPage()

    // 首屏：「在售」段直接吃 `loadPublicUserHome` 那一份，不额外打列表接口
    expect(textOf(page.tree)).toContain('TA 的在售')
    expect(textOf(page.tree)).toContain('在售商品')
    expect(harness.segmentCalls).toEqual([])

    // 埋雷：已售出段取数失败（服务端 5xx）
    harness.segment = async (status) => {
      if (status === 'SOLD') throw apiError('INTERNAL_ERROR', 500)
      return { listings: [listing('lst_active_1', '在售商品', 'ACTIVE')], nextCursor: null }
    }

    clickSegment(page.tree, '卖出')
    await page.settle()

    const failed = segmentFailure(page.tree)
    expect(failed).not.toBeNull()
    // 失败原因写进文案（端上看不到 Console）：码与状态都得在
    expect(failed?.props.text).toBe(
      '已售出商品没拉到，其它内容不受影响（错误码 INTERNAL_ERROR 500）',
    )
    // 「不是空态、不是骨架」：既不许拿「TA 暂无…」冒充结果，也不许一直转圈
    expect(textOf(page.tree)).not.toContain('TA 暂无已售出商品')
    expect(byClass(page.tree, 'uhome__skel')).toHaveLength(0)
    // 也不许退化成整页失败：这一段失败只降级列表，页头两格还得在
    expect(byType(page.tree, 'LoadError')).toHaveLength(0)
    // 失败后不自动补拉：停在失败态的这轮渲染里，接口只被打过一次
    expect(harness.segmentCalls).toEqual(['SOLD'])
    // 也不许静默吞掉：端上看不到 Console，所以页面必须留一条错误日志
    expect(errorSpy).toHaveBeenCalled()

    // 切到另一段：它要照常取数并显示
    clickSegment(page.tree, '在售')
    await page.settle()
    expect(harness.segmentCalls).toEqual(['SOLD', 'ACTIVE'])
    expect(segmentFailure(page.tree)).toBeNull()
    expect(textOf(page.tree)).toContain('在售商品')

    // 切回出错的那一段：再打一次、再失败 —— 必须还是「段内失败」
    clickSegment(page.tree, '卖出')
    await page.settle()
    expect(harness.segmentCalls).toEqual(['SOLD', 'ACTIVE', 'SOLD'])
    const again = segmentFailure(page.tree)
    expect(again).not.toBeNull()
    expect(textOf(page.tree)).not.toContain('TA 暂无已售出商品')
    expect(byClass(page.tree, 'uhome__skel')).toHaveLength(0)

    // 点列表里那颗「重试」：这次服务端好了，列表当场恢复
    harness.segment = async () => ({
      listings: [listing('lst_sold_1', '已售出的商品', 'SOLD')],
      nextCursor: null,
    })
    const retry = again?.props.onAction
    expect(typeof retry).toBe('function')
    ;(retry as () => void)()
    await page.settle()

    expect(harness.segmentCalls).toEqual(['SOLD', 'ACTIVE', 'SOLD', 'SOLD'])
    expect(segmentFailure(page.tree)).toBeNull()
    expect(textOf(page.tree)).toContain('已售出的商品')
    expect(byClass(page.tree, 'uhome__empty')).toHaveLength(0)
  })
})
