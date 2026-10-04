/**
 * Chat 页「会话未读」接线层的回归（#291）。
 *
 * 本仓 `apps/miniapp/tests/` **没有 Taro 组件渲染基建**（页面用真 `@tarojs/taro` 加载会抛
 * `ENABLE_INNER_HTML is not defined`，见 `tests/conversation-unread-count.test.ts` 文件头），
 * 页面接线只能读源码文本钉住 —— 手法同 `tests/following-wiring.test.ts`、
 * `tests/profile-lifecycle.test.ts`。
 *
 * 判据层（端点取值 / `null` 语义）已由 `tests/conversation-unread-count.test.ts` 覆盖；
 * 本文件钉的是**页面有没有把判据接对**。第 9 轮独立审查用四个变异证明：此前全仓
 * `bun test --isolate apps/miniapp`（1096 pass）在这四条接线上**一片全绿**，即接线层
 * 当时零护栏：
 *
 * 1. 把发布 effect 的 `conversations: conversationUnread` 换回 `items.reduce(...)`；
 * 2. 去掉 `loadConversationUnread` 的 `.then` 分支的代次守卫；
 * 3. 去掉身份切换重置块里的 `setConversationUnread(null)`；
 * 4. 把失败分支的 `setConversationUnread(null)` 改成 `setConversationUnread(0)`。
 *
 * 下面每条各有一组断言把它们钉红；四个变异逐条施加后的实测失败输出见 PR 提交信息。
 */
import { describe, expect, test } from 'bun:test'

/** 页面源码（接线层只读文本，仓库没有 Taro 组件渲染基建） */
async function source(): Promise<string> {
  return Bun.file(new URL('../src/pages/chat/index.tsx', import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

/** 断言 `first` 出现在 `second` 之前（两者都必须存在） */
function expectBefore(block: string, first: string, second: string): void {
  const i = block.indexOf(first)
  const j = block.indexOf(second)
  expect(i, `块里应出现 ${first}`).toBeGreaterThanOrEqual(0)
  expect(j, `块里应出现 ${second}`).toBeGreaterThanOrEqual(0)
  expect(i, `${first} 应在 ${second} 之前`).toBeLessThan(j)
}

/** `loadConversationUnread` 的函数体 */
function loadUnreadBlock(code: string): string {
  return sliceFrom(code, 'const loadConversationUnread = useCallback', '}, [])')
}

/** `loadConversationUnread` 的成功分支（`.then` → 下一个 `.catch(`） */
function thenBranch(code: string): string {
  return sliceFrom(loadUnreadBlock(code), '.then((count) => {', '.catch(')
}

/** `loadConversationUnread` 的失败分支（`.catch((error) => {` → 函数体结尾） */
function catchBranch(code: string): string {
  return sliceFrom(loadUnreadBlock(code), '.catch((error) => {', '      })')
}

describe('#291 Chat 页会话未读 · 接线', () => {
  test('底栏快照发的是端点值 conversationUnread，不是对本页会话列表求和（#291 验收）', async () => {
    const code = await source()

    /*
     * #291 的验收就是「仓库内不再有对会话列表求和的会话未读计算」。chat 页当前没有任何
     * `reduce`，所以这里可以直接对整文件禁 `.reduce(`；**若将来本页出现别的合法 reduce**
     * （与本页会话未读无关），把这条换成精确断言 `expect(code).not.toContain('items.reduce(')`
     * 并在注释里说明，不要为了让它过而放宽发布 effect 那条。
     */
    expect(code).not.toContain('.reduce(')

    const publish = sliceFrom(code, 'publishUnread({', '    })')
    expect(publish).toContain('conversations: conversationUnread')
    // 发布 effect 里不许再引用 `items`：它只有第一页（契约上限 50 条），求和会漏计
    expect(publish).not.toContain('items')
  })

  test('loadConversationUnread 的 then / catch 两个分支都过代次守卫', async () => {
    const code = await source()
    const thenPart = thenBranch(code)
    const catchPart = catchBranch(code)

    // 成功分支：守卫必须在 setConversationUnread(count) 之前 —— 换账号后迟到的响应
    // 不得把上个账号的未读数写进新账号快照
    expectBefore(
      thenPart,
      'if (epoch !== listEpoch.current) return',
      'setConversationUnread(count)',
    )
    // 失败分支同样要守卫：否则旧账号的失败回包会把新账号刚拿到的真值改写成「不知道」
    expectBefore(
      catchPart,
      'if (epoch !== listEpoch.current) return',
      'setConversationUnread(null)',
    )
  })

  test('身份切换重置块自增代次，并把未读总数记成「不知道」（null）', async () => {
    const code = await source()
    const reset = sliceFrom(code, 'if (prevIdentity !== identity) {', 'setTxSignals(new Map())')

    // 自增放在渲染期，作废在途响应（列表 / 未读 / 通知）
    expect(reset).toContain('listEpoch.current += 1')
    // 未读总数属于上一个账号：必须换成 null，不能留着旧值挂在新账号的红点上
    expect(reset).toContain('setConversationUnread(null)')
  })

  test('失败分支写「不知道」（null），不拿 0 冒充', async () => {
    const code = await source()

    // 全文件都不该出现 0：0 是「确定没有未读」这个具体结论，会覆盖上一份正确快照
    expect(code).not.toContain('setConversationUnread(0)')
    expect(catchBranch(code)).toContain('setConversationUnread(null)')
  })
})
