/**
 * 自定义底栏「显示时刷新未读」（#170 D）的判据与接线回归。
 *
 * 底栏是框架渲染的独立组件（`app.config.ts` 的 `tabBar.custom` + `src/custom-tab-bar/`），
 * 它没有页面组件那样的渲染测试基建 —— 组件本身在测试里跑不起来。所以这里分三层：
 *
 * - **判据层**：`src/custom-tab-bar/view.ts` 的 `refreshTargetOnShow` 直接跑行为用例；
 * - **行为层**在 store 侧：`unread-hydrate.test.ts` 的「显示时刷新」用例锁住
 *   `refreshUnread` 的取数、作废与不降级口径；
 * - **接线层**（本文件）读 `src/custom-tab-bar/index.tsx` 的源码文本，钉住组件真的按
 *   这些判据接线、护栏在发请求之前，且没有绕过 store 另造一套求和规则。
 *
 * 只钉「字符串出现过」是不够的：把护栏挪到调用之后、把刷新换成一次性补数、或者
 * 干脆把护栏**注释掉**，组件照样能被编译、行为层也照样全绿。所以关键位置都用
 * `indexOf` 比较钉住，并先剥掉注释再断言。
 */
import { describe, expect, test } from 'bun:test'
import { refreshTargetOnShow } from '../src/custom-tab-bar/view'

/** 底栏组件源码（接线层只读文本，不渲染 Taro 组件） */
async function source(): Promise<string> {
  return Bun.file(new URL('../src/custom-tab-bar/index.tsx', import.meta.url)).text()
}

/** 去掉注释：把护栏「注释掉」的变异不该还能满足「护栏存在」的断言 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `底栏里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

/** 断言 `first` 出现在 `second` 之前（两者都必须存在） */
function expectBefore(block: string, first: string, second: string): void {
  const i = block.indexOf(first)
  const j = block.indexOf(second)
  expect(i, `应出现 ${first}`).toBeGreaterThanOrEqual(0)
  expect(j, `应出现 ${second}`).toBeGreaterThanOrEqual(0)
  expect(i, `${first} 应在 ${second} 之前`).toBeLessThan(j)
}

/** 显示时刷新的那段回调（已剥注释） */
function showBlock(code: string): string {
  return stripComments(sliceFrom(code, 'useDidShow(() => {', '\n  })'))
}

describe('#170 D 判据层：什么时候该为哪个账号刷新', () => {
  test('已登录且身份就绪 → 为本次账号刷新', () => {
    expect(refreshTargetOnShow({ authed: true, userId: 'u-a', hiddenRoute: false })).toBe('u-a')
  })

  test('未登录 / 身份未就绪不刷新', () => {
    expect(refreshTargetOnShow({ authed: false, userId: null, hiddenRoute: false })).toBeNull()
    expect(refreshTargetOnShow({ authed: true, userId: null, hiddenRoute: false })).toBeNull()
    expect(refreshTargetOnShow({ authed: false, userId: 'u-a', hiddenRoute: false })).toBeNull()
  })

  test('不渲染底栏的出物页不刷新', () => {
    expect(refreshTargetOnShow({ authed: true, userId: 'u-a', hiddenRoute: true })).toBeNull()
  })

  test('返回的是账号本身：调用方据此完成类型收窄', () => {
    expect(refreshTargetOnShow({ authed: true, userId: 'u-b', hiddenRoute: false })).toBe('u-b')
  })
})

describe('#170 D 接线层：底栏在显示时刷新未读', () => {
  test('组件注册了 useDidShow（自定义 tabBar 的 pageLifetimes.show 会派发到它）', async () => {
    const code = await source()
    expect(code).toContain("import Taro, { useDidShow } from '@tarojs/taro'")
    expect(code).toContain('useDidShow(() => {')
  })

  test('useDidShow 注册在所有 hook 区、早退之前（hook 数量不随路由变化）', async () => {
    const code = await source()
    // 早退（出物页不渲染底栏）写在所有 hook 之后是既有约定，新增 hook 不能越过它
    expectBefore(
      code,
      'useDidShow(() => {',
      'if (currentRoute().includes(HIDDEN_ROUTE)) return null',
    )
  })

  test('显示链走 store 的刷新入口，而不是一次性的冷启动补数', async () => {
    const code = await source()
    const block = showBlock(code)
    expect(block).toContain('refreshUnread(ownerId, demoUnread)')
    // 补数在「已有快照」时会直接返回，拿它当显示时刷新等于永远不刷新
    expect(block).not.toContain('hydrateUnread(')
    // 两条刷新入口：页面显示（`useDidShow`）与整包回到前台（`Taro.onAppShow`，#67 第三步）；
    // 冷启动补数仍然只有挂载期那一次
    expect(code.split('refreshUnread(').length - 1).toBe(2)
    expect(code.split('hydrateUnread(').length - 1).toBe(1)
  })

  test('整包回到前台也刷新，且注册 / 注销成对（#67 第三步与 #170 D 并存）', async () => {
    const code = stripComments(await source())
    const block = sliceFrom(code, 'const refreshRef = useRef', '}, [])')
    expect(block).toContain('Taro.onAppShow(onShow)')
    // 不注销的话每次重挂底栏都会多一个监听器，一次前台事件打多次请求
    expect(block).toContain('Taro.offAppShow(onShow)')
    // 判据与显示链同一份（不是另写一套 `authed && userId`），且同样走 store 的刷新入口
    expect(block).toContain('refreshTargetOnShow({')
    expect(block).toContain("authed: authStatus === 'authed'")
    // 出物页不渲染底栏：这条路径也要带上同一个「出物页不刷」判据，不能只顾显示链
    expect(block).toContain('hiddenRoute: currentRoute().includes(HIDDEN_ROUTE)')
    expectBefore(block, 'if (!ownerId) return', 'refreshUnread(ownerId, demoUnread)')
  })

  test('不跳过任何一次显示（每个 Tab 页各一份实例，跳过首次 = 该页第一次打开不刷新）', async () => {
    const code = await source()
    expect(code).not.toContain('skipFirstShowRef')
    const block = showBlock(code)
    // 判据的入参只有「登录态 / 身份 / 是否隐藏路由」，没有「第几次显示」
    expect(block).toContain('refreshTargetOnShow({')
    expect(block).not.toContain('firstShow')
  })

  test('门禁走 ./view 的纯函数判据，而不是组件里另写一套', async () => {
    const code = await source()
    const block = showBlock(code)
    expect(block).toContain('refreshTargetOnShow({')
    expect(block).toContain("authed: authStatus === 'authed'")
    expect(block).toContain('userId,')
    // 用正则锚住整段（只 toContain 前缀会漏掉 `!currentRoute()...` 这种取反）
    expect(block).toMatch(/hiddenRoute: currentRoute\(\)\.includes\(HIDDEN_ROUTE\),/)
  })

  test('守卫在发请求之前：判据返回空就直接返回', async () => {
    const code = await source()
    const block = showBlock(code)
    expectBefore(block, 'refreshTargetOnShow({', 'if (!ownerId) return')
    expectBefore(block, 'if (!ownerId) return', 'refreshUnread(ownerId, demoUnread)')
    /*
      判据与刷新必须紧邻，且整个显示块只有这一个 return：只要有人重新引入「第几次显示
      才刷」的提前返回（不管叫什么名字、用什么标记），这两条断言之一就会失败。
      只断言「不含 skipFirstShowRef / firstShow 这些名字」是钉不住的 —— 改个名字照样能
      把首次显示跳过去。
    */
    expect(block.replace(/\s+/g, ' ')).toContain(
      'if (!ownerId) return refreshUnread(ownerId, demoUnread)',
    )
    expect(block.match(/\breturn\b/g)?.length).toBe(1)
  })

  test('冷启动补数仍然保留（登录态在首次显示之后才解析出来时靠它）', async () => {
    const code = await source()
    expect(code).toContain('hydrateUnread(userId, demoUnread)')
    expect(code).toContain('}, [authStatus, userId, demoUnread])')
  })

  test('未登录时底栏自己也清场（底栏会建快照，不能只靠消息页）', async () => {
    const code = await source()
    const block = stripComments(
      sliceFrom(code, "if (authStatus !== 'authed' || !userId) {", '\n    }'),
    )
    expect(block).toContain('setDot(false)')
    expectBefore(block, 'setDot(false)', 'clearUnread()')
  })

  test('不绕过 store 直接打接口（消费现有全量未读 API，不另造规则）', async () => {
    const code = await source()
    expect(code).not.toContain('fetchUnreadNotificationCount')
    expect(code).not.toContain('fetchConversationUnreadCount')
    expect(code).not.toContain('fetchConversations')
  })

  test('求和只出现在演示兜底那一处，不新增首屏求和口径', async () => {
    const code = await source()
    // 唯一的求和是既有的 demoUnread（演示 / 开发构建的 fixture 兜底）
    expect(code.split('.reduce(').length - 1).toBe(1)
    expect(code).toContain('MOCK_FALLBACK_ENABLED')
  })

  test('红点仍与消息页同源（快照按账号校验 + badgeShouldLight，且结果不被取反）', async () => {
    const code = await source()
    expect(code).toContain('unread.ownerId === userId')
    expect(code).toContain('badgeShouldLight({')
    // 取反会让红点语义整体反过来（红点亮灭正好相反），这里钉住极性
    expect(code).not.toContain('!badgeShouldLight(')
  })
})
