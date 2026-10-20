/**
 * 拉黑域纯函数单测（#473）。`features/blocks/view.ts` 不 import Taro，bun test 直接跑。
 * 页面接线（哪些函数被哪些页面调用）由 `tests/blocks-wiring.test.ts` 源码文本钉住。
 */
import { describe, expect, test } from 'bun:test'
import {
  type BlocksLoad,
  blockConfirmModal,
  blockEntryView,
  blockReadOf,
  describeBlockFailure,
  moreReplyLanded,
  nextBlocksLoad,
} from '../src/features/blocks/view'

/** 与 `lib/request` 的 ApiError 同形状（三个特征），但不 import 它（那会拖进 Taro）。 */
function apiErrorLike(code: string, status: number): Error & { code: string; status: number } {
  return Object.assign(new Error('服务端文案'), { name: 'ApiError', code, status })
}

describe('describeBlockFailure（域内错误码 → 行内文案）', () => {
  test('USER_NOT_FOUND / CANNOT_BLOCK_SELF 各有稳定文案', () => {
    expect(describeBlockFailure(apiErrorLike('USER_NOT_FOUND', 404))).toBe('用户不存在或不可见')
    expect(describeBlockFailure(apiErrorLike('CANNOT_BLOCK_SELF', 422))).toBe('不能拉黑自己')
  })

  test('域外错误（网络 / 未识别码 / 非 ApiError）一律「操作失败，请重试」', () => {
    expect(describeBlockFailure(new Error('boom'))).toBe('操作失败，请重试')
    expect(describeBlockFailure(apiErrorLike('SOMETHING_ELSE', 500))).toBe('操作失败，请重试')
    expect(describeBlockFailure(undefined)).toBe('操作失败，请重试')
  })

  test('形状不全的仿冒对象不按 ApiError 判（name/code/status 三特征缺一不可）', () => {
    const partial = Object.assign(new Error('x'), { code: 'USER_NOT_FOUND', status: 404 })
    expect(describeBlockFailure(partial)).toBe('操作失败，请重试')
  })
})

describe('blockEntryView（他人主页入口 UI 状态）', () => {
  /** key = 账号|页主，与关注钮同一把钥匙 */
  const owner = 'user-1|seller-1'

  test('读到状态之前：不渲染（绝不猜一个状态画上去；读失败由页面保持 null）', () => {
    expect(blockEntryView({ read: null, key: owner, pending: false }).visible).toBe(false)
  })

  test('未拉黑 → 「拉黑该用户」；已拉黑 → 「解除拉黑」', () => {
    const notBlocked = blockEntryView({
      read: { key: owner, blocked: false },
      key: owner,
      pending: false,
    })
    expect(notBlocked).toEqual({
      visible: true,
      label: '拉黑该用户',
      busy: false,
      blocked: false,
    })
    const blocked = blockEntryView({
      read: { key: owner, blocked: true },
      key: owner,
      pending: false,
    })
    expect(blocked.label).toBe('解除拉黑')
    expect(blocked.blocked).toBe(true)
  })

  test('写入中：busy + 按当前状态给「拉黑中…/解除中…」，不翻转语义', () => {
    expect(
      blockEntryView({ read: { key: owner, blocked: false }, key: owner, pending: true }),
    ).toEqual({
      visible: true,
      label: '拉黑中…',
      busy: true,
      blocked: false,
    })
    expect(
      blockEntryView({ read: { key: owner, blocked: true }, key: owner, pending: true }).label,
    ).toBe('解除中…')
  })
})

/**
 * #484 审查第 ① 条（换页主 / 换账号的那几帧）：读到的拉黑态必须**带着归属**。
 *
 * 修复前 `blockRead` 不带归属：换页主后要等 effect 到下一帧才写回 `null`，中间那一帧
 * 会拿**上一个页主**的 `blocked` 画出按钮 —— 在 A 的主页看到「解除拉黑」，点下去发的
 * 是对 B 的解除请求。修复后归属不符就当没读到（不渲染、点击也不可用）。
 */
describe('blockReadOf（读到的状态是否还属于当前 owner）', () => {
  test('归属不符 ⇒ 当没读到，旧 owner 的 blocked 不泄漏给渲染', () => {
    const stale = { key: 'user-1|seller-a', blocked: true }
    expect(blockReadOf(stale, 'user-1|seller-b')).toBeNull()
    expect(blockEntryView({ read: stale, key: 'user-1|seller-b', pending: false }).visible).toBe(
      false,
    )
  })

  test('换账号同样作废（key = 账号|页主）', () => {
    const stale = { key: 'user-1|seller-a', blocked: true }
    expect(blockReadOf(stale, 'user-2|seller-a')).toBeNull()
  })

  test('归属相符才按状态给视图', () => {
    expect(blockReadOf({ key: 'user-1|seller-a', blocked: true }, 'user-1|seller-a')).toEqual({
      blocked: true,
    })
    expect(blockReadOf(null, 'user-1|seller-a')).toBeNull()
  })
})

/**
 * #484 审查第 ② 条：解除成功后，**解除之前**发出的首屏回包不得把那一行塞回来。
 * 修复前一份「还带着这个人」的旧快照会直接落地，用户看到「已解除拉黑」却没少一行，
 * 再点一次就是对已经不存在的拉黑发请求。
 */
describe('nextBlocksLoad（首屏快照的代次落地）', () => {
  const rowA = { id: 'a', nickname: 'A', avatarUrl: null, blockedAt: '2026-10-01T00:00:00.000Z' }
  const rowB = { id: 'b', nickname: 'B', avatarUrl: null, blockedAt: '2026-10-01T00:00:00.000Z' }
  /** 解除成功后本地快照的面貌：B 已被摘掉，代次自增到 2。 */
  const unblocked: BlocksLoad = { kind: 'ready', rows: [rowA], nextCursor: null, gen: 2 }

  test('旧代次快照（解除前发出、解除后到达）不落地，刚摘掉的行不会被塞回来', () => {
    const staleReply: BlocksLoad = { kind: 'ready', rows: [rowA, rowB], nextCursor: null, gen: 1 }
    expect(nextBlocksLoad(unblocked, staleReply)).toBe(unblocked)
  })

  test('同代 / 更新代照常落地（下拉刷新、重进页要能刷新列表）', () => {
    const sameGen: BlocksLoad = { kind: 'ready', rows: [rowA, rowB], nextCursor: 'c1', gen: 2 }
    expect(nextBlocksLoad(unblocked, sameGen)).toBe(sameGen)

    const newerGen: BlocksLoad = { kind: 'ready', rows: [], nextCursor: null, gen: 3 }
    expect(nextBlocksLoad(unblocked, newerGen)).toBe(newerGen)
  })

  test('错误态 / 加载态不参与代次比较（照常切态，否则重试会卡在错误态）', () => {
    expect(nextBlocksLoad(unblocked, { kind: 'error' })).toEqual({ kind: 'error' })
    expect(nextBlocksLoad({ kind: 'loading' }, unblocked)).toBe(unblocked)
  })
})

/**
 * #484 审查第 ③ 条：「加载更多」的收尾只归令牌持有者。修复前两次请求都能走到
 * `finally`，被顶替的旧请求会替新请求熄掉加载态、或把失败算到新请求头上。
 */
describe('moreReplyLanded（加载更多的持有者判据）', () => {
  const mine = Symbol('mine')
  const others = Symbol('others')

  test('持有者且代次未变 ⇒ 可以落地 / 可以收尾', () => {
    expect(moreReplyLanded({ gen: 1, genNow: 1, token: mine, tokenNow: mine })).toBe(true)
  })

  test('被顶替（令牌易主）⇒ 不许收尾', () => {
    expect(moreReplyLanded({ gen: 1, genNow: 1, token: mine, tokenNow: others })).toBe(false)
    // runLoad 会先把令牌交回 null：被取消的旧请求随后 reject 时同样不许收尾
    expect(moreReplyLanded({ gen: 1, genNow: 1, token: mine, tokenNow: null })).toBe(false)
  })

  test('代次已变（解除成功 / 换账号）⇒ 旧回包不许落地', () => {
    expect(moreReplyLanded({ gen: 1, genNow: 2, token: mine, tokenNow: mine })).toBe(false)
  })
})

describe('blockConfirmModal（拉黑确认弹窗文案）', () => {
  test('标题带昵称；后果说明覆盖双向拦截 / 交易不受影响 / 可解除', () => {
    const modal = blockConfirmModal('张三')
    expect(modal.title).toBe('拉黑「张三」？')
    expect(modal.confirmText).toBe('确认拉黑')
    expect(modal.content).toContain('双方都无法再发消息')
    expect(modal.content).toContain('新建会话')
    expect(modal.content).toContain('面交流程不受影响')
    expect(modal.content).toContain('可随时解除')
  })
})
