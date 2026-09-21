import { describe, expect, test } from 'bun:test'
import { applyLoadResult, homeListState, resolveLoadedFor } from '../src/pages/home/list-state'

/**
 * 首页分类页内切换的状态机（#137）。
 *
 * 这个状态机已经连续三次被独立审查抓到同族缺陷，每次都是「屏幕上显示的东西
 * 与事实不符」：旧商品冒充新分类（2ff5de4）、失败假空态（c7ec13d）、
 * 失败后 `loadedFor` 未失效导致重试期间又显示假空态（rebase 至 #129 后的审查）。
 * 判定抽成纯函数后，每种组合都有用例锁住。
 *
 * 注意「组件接线」这一层没有单测（本仓 tests/ 只有纯逻辑测试、无 Taro 组件
 * 渲染基建）：`pages/home/index.tsx` 调不调这些函数、传什么参数，靠 code review
 * 保证。函数内部的回归由这里的用例保证。
 */

describe('resolveLoadedFor —— loadedFor 结转规则', () => {
  test('成功：记住这批商品属于请求的分类', () => {
    expect(resolveLoadedFor('BOOKS', false)).toBe('BOOKS')
    expect(resolveLoadedFor('ALL', false)).toBe('ALL')
  })

  test('失败：作废为 null —— 屏幕上已没有属于任何分类的有效数据', () => {
    // 修复前组件在失败时保留旧值：失败的目标分类恰是上次成功过的那个时
    // （重试 / 下拉刷新失败后重试 / 失败后切回），loadedFor === category 成立、
    // items 已空 → 渲染「这个分类还没有闲置」，把「没读到」说成「这个分类没货」。
    expect(resolveLoadedFor('BOOKS', true)).toBeNull()
    expect(resolveLoadedFor('ALL', true)).toBeNull()
  })
})

describe('homeListState —— 商品区渲染形态', () => {
  test('失败 → 错误态，且优先于其它一切判断', () => {
    // 「加载不出来」不是「恰好没有商品」：即使列表刚好对上了当前分类
    expect(homeListState({ loadedFor: 'ALL', category: 'ALL', failed: true, itemCount: 0 })).toBe(
      'error',
    )
    // 失败 + 分类还没对上：同样先报错，不显示骨架屏（错误块自带重试）
    expect(homeListState({ loadedFor: 'ALL', category: 'BOOKS', failed: true, itemCount: 0 })).toBe(
      'error',
    )
  })

  test('loadedFor 为 null（首次进页 / 失败作废后的重试在途）→ 骨架屏，不是空态', () => {
    // 首次进页：items 初始为空，直接走空态判断会先闪一下「这个分类还没有闲置」再出商品。
    // 失败后重试在途：load 先清了 failed、items 还是空、loadedFor 已被作废 —— 同一个形状，
    // 也必须走骨架屏（rebase 审查 P1：修复前这里 loadedFor 保留旧值 → 空态）。
    expect(homeListState({ loadedFor: null, category: 'ALL', failed: false, itemCount: 0 })).toBe(
      'skeleton',
    )
    expect(homeListState({ loadedFor: null, category: 'BOOKS', failed: false, itemCount: 0 })).toBe(
      'skeleton',
    )
  })

  test('切分类在途（loadedFor ≠ category）→ 骨架屏，旧商品不冒充新分类', () => {
    // 选中态已跳到「教材书籍」、屏幕上还是推荐流的商品：这段时间必须显示加载态
    expect(
      homeListState({ loadedFor: 'ALL', category: 'BOOKS', failed: false, itemCount: 12 }),
    ).toBe('skeleton')
    // 具体分类之间互切同理
    expect(
      homeListState({ loadedFor: 'BOOKS', category: 'DIGITAL', failed: false, itemCount: 3 }),
    ).toBe('skeleton')
  })

  test('成功拿到空列表 → 空态（只有这时才能说「这个分类还没有闲置」）', () => {
    expect(
      homeListState({ loadedFor: 'BOOKS', category: 'BOOKS', failed: false, itemCount: 0 }),
    ).toBe('empty')
  })

  test('列表已对上当前分类且有商品 → 列表', () => {
    expect(
      homeListState({ loadedFor: 'BOOKS', category: 'BOOKS', failed: false, itemCount: 7 }),
    ).toBe('list')
    expect(homeListState({ loadedFor: 'ALL', category: 'ALL', failed: false, itemCount: 40 })).toBe(
      'list',
    )
  })
})

describe('一次加载的完整结转（rebase 审查 P1 的回归锁）', () => {
  /*
   * 用户可见路径：推荐加载成功 → 断网 → 点「推荐」重试失败 → 再点「推荐」。
   * 修复前第三步渲染「这个分类还没有闲置」（假空态）；修复后是骨架屏。
   *
   * 为什么必须是这条组合用例：`homeListState({loadedFor:null,…}) → skeleton` 单测
   * 锁不住这个 bug（修复前后该形状都说得通），`resolveLoadedFor` 单测锁不住组件
   * 接线。只有把「结转 → 渲染」按用户操作顺序串起来，修复前的实现才会在某一步
   * 给出不同答案：失败那一步的 loadedFor 会保留 'ALL' 而不是 null，最后一步
   * 因此落到空态。
   */
  test('推荐成功 → 重试失败 → 再点推荐：重试在途必须是骨架屏', () => {
    // 1. 后端可达，进首页，「推荐」加载成功
    let state = applyLoadResult({ requested: 'ALL', items: [1, 2, 3], failed: false })
    expect(state.loadedFor).toBe('ALL')
    expect(
      homeListState({
        loadedFor: state.loadedFor,
        category: 'ALL',
        failed: state.failed,
        itemCount: state.items.length,
      }),
    ).toBe('list')

    // 2. 停后端，点「推荐」重试 → 失败：items 清空、loadedFor 作废
    state = applyLoadResult({ requested: 'ALL', items: [], failed: true })
    expect(state.items).toEqual([])
    expect(state.loadedFor).toBeNull() // 修复前：保留上一步的 'ALL'
    expect(
      homeListState({
        loadedFor: state.loadedFor,
        category: 'ALL',
        failed: state.failed,
        itemCount: state.items.length,
      }),
    ).toBe('error')

    // 3. 再点「推荐」：load 先 setFailed(false)，请求在途 → 骨架屏（修复前这里是空态）
    expect(
      homeListState({
        loadedFor: state.loadedFor,
        category: 'ALL',
        failed: false,
        itemCount: state.items.length,
      }),
    ).toBe('skeleton')
  })

  test('切到新分类失败后切回已成功过的分类：重试在途同样是骨架屏', () => {
    // 「推荐」成功后切「教材书籍」失败，再点回「推荐」—— 与上一条同为 P1 形状，
    // 区别在中间多了一次切分类，锁住 loadedFor 不被中途的成功态污染
    let state = applyLoadResult({ requested: 'ALL', items: [1, 2], failed: false })
    state = applyLoadResult({ requested: 'BOOKS', items: [], failed: true })
    expect(state.loadedFor).toBeNull()
    // 切回「推荐」：onCategoryTap 里 setCategory('ALL') + load('ALL')，
    // 请求在途期间的渲染（failed 已清、items 空）
    expect(
      homeListState({ loadedFor: state.loadedFor, category: 'ALL', failed: false, itemCount: 0 }),
    ).toBe('skeleton')
  })
})
