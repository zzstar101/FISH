/**
 * 「我的发布」路由参数分段入口与通知分派的接线（#520）。
 *
 * 本仓 `apps/miniapp/tests/` 没有 Taro 组件渲染基建（真 `@tarojs/taro` 加载会抛
 * `ENABLE_INNER_HTML is not defined`），页面接线只能读源码文本钉住 —— 手法同
 * `tests/conversation-tx-bar-wiring.test.ts`。断言前把空白压掉：钉的是**语句结构**
 * 而不是 Biome 的折行位置（格式化改动不该打红接线测试）。
 *
 * 判据层（参数白名单 / 非法回落「在售」）由 `tests/mylist-list.test.ts` 的
 * `initialSegmentOf` 覆盖；本文件钉的是两处**接线**有没有接对：
 * - 页面用 `router.params.segment` 作 segment 状态的**初值**（useState initializer，
 *   只在首挂载读一次，换号清场仍回落「在售」—— 既有行为不变）；
 * - 通知分派把 TX `PROPOSED` 的 `segment: 'pending'` 翻译成页面查询参数（审核结果
 *   的 `{ kind: 'mylist' }` 不带段，落在「在售」，行为不变）。
 */
import { describe, expect, test } from 'bun:test'

async function source(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text()
}

/** 压掉全部空白：断言只认语句结构，不认折行 */
function squash(code: string): string {
  return code.replace(/\s+/g, '')
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `源码里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

describe('mylist 页：路由参数 → 初始分段', () => {
  test('页面声明 useRouter 且读 segment 参数', async () => {
    const page = squash(await source('../src/pkg-browse/pages/mylist/index.tsx'))
    expect(page).toContain(squash('useRouter<{ segment?: string }>()'))
    // useRouter 必须来自 @tarojs/taro（页面的 Taro 导入行上）
    expect(page).toContain(squash("useRouter } from '@tarojs/taro'"))
  })

  test('segment 状态的初值整句来自 initialSegmentOf(router.params.segment)', async () => {
    const page = await source('../src/pkg-browse/pages/mylist/index.tsx')
    // 钉整条函数式写入语句（含参数来源）：只钉「initialSegmentOf 在文件里出现」
    // 会被「调用了但没接到状态上」骗过。先切片整条声明再压空白 —— Biome 的折行
    // 位置不该打红接线测试。
    const decl = squash(sliceFrom(page, 'const [segment, setSegment]', 'router.params.segment)'))
    expect(decl).toContain(squash('useState<MyListSegment>(() =>'))
    expect(decl).toContain(squash('initialSegmentOf(router.params.segment)'))
    // 判据必须来自 ./list 的纯函数，不许页面里各写一份白名单
    expect(page).toContain('initialSegmentOf,')
  })
})

describe('chat 页：通知分派把 segment 翻译成页面查询参数', () => {
  test('mylist 分派带 ?segment=pending（PROPOSED 直落待确认段）', async () => {
    const page = await source('../src/pages/chat/index.tsx')
    const branch = squash(sliceFrom(page, "item.target?.kind === 'mylist'", 'return\n    }'))
    expect(branch).toContain(squash("item.target.segment === 'pending'"))
    expect(branch).toContain('?segment=pending')
    // 不带段的 mylist 目标（审核结果）仍落到页面默认段，不得强制 pending
    expect(branch).toContain('constsegment=')
  })
})
