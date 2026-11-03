import { describe, expect, mock, test } from 'bun:test'
import type { DisputeStatus } from '@fish/contracts/disputes/schema'

/**
 * 争议详情页异步生命周期的回归（账号隔离 / 卸载 / 争议状态变化）。
 *
 * 页面的六条异步动线（撤回、撤回确认弹窗、选图上传、读候选消息、翻更早、加证据、预览大图）
 * 都在 `await` 之后写状态或再发请求。旧实现这几处只看 `alive`（页面还挂着）或什么都不看：
 * 换号时页面**不卸载**，于是上一账号的响应会回写进新账号的界面，上传链更会带着新账号的
 * 会话去 confirm 上一账号的争议；`addAttachments` 还把「抓身份」放在 `pickPhotos` 之后，
 * 选图期间换号就会用新身份继续处理旧争议。本文件锁四件事：
 *
 * 1. 判据层 —— `opAliveIn` / `opWritableIn` 的语义，尤其是「写回作废」与「忙位必须放掉」
 *    这对**不同**的判据（同号静默刷新会推进世代：写回要丢，锁必须放，否则按钮永久卡住）；
 * 2. 接线层 —— 每条动线在 `await` **之前**抓身份令牌、在写回/副作用**之前**核身份，
 *    只钉「守卫存在」不够：把守卫挪到 setter 之后仍然会全绿，所以断言的是**位置**；
 * 3. 收尾层 —— `finally` 只判「还是同一账号」而不判世代，且换号清场把在途闩锁一并放掉；
 * 4. 不回退 —— 409 静默重同步、游标分页、附件与证据的幂等去重、PENDING 发起人权限仍在。
 *
 * 边界：没有组件渲染基建（仓里 `tests/` 只有纯逻辑与源码切片），所以接线层证明的是源码里
 * 这些语句的**位置**，不是运行时时序（React 批处理、ref 读取时刻）。端上时序仍按
 * `docs/miniapp-dev-workflow.md` 在微信开发者工具里演示，不拿本文件当端上证明。
 */

// 页面模块经 `features/auth/store` → `demo.ts` 在求值期读这两个全局常量；缺了会 ReferenceError
Object.assign(globalThis, { __ALLOW_MOCK_FALLBACK__: false, __DEMO_AUTH__: false })

// 页面只用 Taro 的运行时 API 与四个基础组件；判据层是纯函数，不需要真渲染
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
  },
  useDidShow: () => {},
  useRouter: () => ({ params: {} }),
}))

/** 页面导出的判据（模块级导出，不依赖 Taro 运行时） */
type PageModule = typeof import('../src/pkg-trade/pages/dispute-detail/index')

let pageModule: PageModule | null = null

async function page(): Promise<PageModule> {
  if (pageModule === null) pageModule = await import('../src/pkg-trade/pages/dispute-detail/index')
  return pageModule
}

/** 发起一次异步操作时的归属令牌（页面的 `OpScope`） */
type Op = { userId: string | null; disputeId: string; epoch: number; ownerEpoch: number }

/** 页面这一刻的身份快照（页面的 `PageIdentity`） */
type Identity = {
  alive: boolean
  epoch: number
  ownerEpoch: number
  userId: string | null
  disputeId: string | null
  status: DisputeStatus | null
}

const OP: Op = { userId: 'usr_a', disputeId: 'dsp_1', epoch: 7, ownerEpoch: 1 }
const NOW: Identity = {
  alive: true,
  epoch: 7,
  ownerEpoch: 1,
  userId: 'usr_a',
  disputeId: 'dsp_1',
  status: 'PENDING',
}

/**
 * 页面里 `opSameAccount` 的判据（收尾用）：只看「页面还在 + 还是同一账号」，不看出身世代。
 *
 * 页面没有导出它（它不是业务判据，只是忙位收尾的闸门），所以这里按同一表达式建模，
 * 并由下面的接线测试钉住源码里确实是这个表达式。
 */
function sameAccountIn(op: Op, now: Identity): boolean {
  return now.alive && op.userId === now.userId && op.ownerEpoch === now.ownerEpoch
}

describe('判据：写回资格与忙位收尾是两把不同的闸门', () => {
  test('账号 + 争议 + 世代都对得上才允许写回', async () => {
    const { opAliveIn } = await page()
    expect(opAliveIn(OP, NOW)).toBe(true)
  })

  test('同号静默刷新推进世代：写回作废，但忙位必须放掉（否则按钮永久卡在「上传中…」）', async () => {
    const { opAliveIn } = await page()
    const refreshed: Identity = { ...NOW, epoch: 8 }
    expect(opAliveIn(OP, refreshed)).toBe(false)
    expect(sameAccountIn(OP, refreshed)).toBe(true)
  })

  test('换号：写回作废，忙位也不归旧链管（新账号的页面自己那份状态由它自己维护）', async () => {
    const { opAliveIn } = await page()
    const switched: Identity = { ...NOW, userId: 'usr_b', disputeId: null, status: null, epoch: 8 }
    expect(opAliveIn(OP, switched)).toBe(false)
    expect(sameAccountIn(OP, switched)).toBe(false)
  })

  test('卸载：两把闸门一起关', async () => {
    const { opAliveIn } = await page()
    const gone: Identity = { ...NOW, alive: false }
    expect(opAliveIn(OP, gone)).toBe(false)
    expect(sameAccountIn(OP, gone)).toBe(false)
  })

  test('争议被换成另一条（或还没读到）：旧响应不许写回', async () => {
    const { opAliveIn } = await page()
    expect(opAliveIn(OP, { ...NOW, disputeId: 'dsp_2' })).toBe(false)
    expect(opAliveIn(OP, { ...NOW, disputeId: null, status: null })).toBe(false)
  })

  test('补材料资格 = 写回资格 + 争议仍是 PENDING（撤回 / 处理完就停手）', async () => {
    const { opAliveIn, opWritableIn } = await page()
    expect(opWritableIn(OP, NOW)).toBe(true)
    for (const status of ['WITHDRAWN', 'RESOLVED', 'CANCELLED'] as const) {
      const settled: Identity = { ...NOW, status }
      // 详情本身仍可写回（撤回成功后正是要把新状态写进页面），但不能再补材料
      expect(opAliveIn(OP, settled)).toBe(true)
      expect(opWritableIn(OP, settled)).toBe(false)
    }
  })
})

/** 页面源码（接线层只读源码，不跑组件） */
async function pageSource(): Promise<string> {
  return await Bun.file(
    new URL('../src/pkg-trade/pages/dispute-detail/index.tsx', import.meta.url),
  ).text()
}

/** 从 `const <name> = ` 切到其后第一个顶层 `const ` 定义之前（页面里这些动线是相邻的 `const`） */
function handlerBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = `)
  expect(start, `页面里找不到 ${name}`).toBeGreaterThan(-1)
  const end = source.indexOf('\n  const ', start + 1)
  return source.slice(start, end === -1 ? undefined : end)
}

/** `from` 到其后第一个 `to` 之间的源码（`from` 之后开始，避免把上一个动线的尾巴算进来） */
function sliceBetween(block: string, from: string, to: string): string {
  const start = block.indexOf(from)
  expect(start, `缺少片段：${from}`).toBeGreaterThan(-1)
  const end = block.indexOf(to, start + 1)
  expect(end, `缺少片段：${to}`).toBeGreaterThan(start)
  return block.slice(start, end)
}

/** 断言 `first` 出现在 `second` **之前**（两者都必须真的存在，只钉存在会漏掉「守卫挪到 setter 之后」） */
function expectBefore(block: string, first: string, second: string): void {
  const head = block.indexOf(first)
  const tail = block.indexOf(second)
  expect(head, `缺少片段：${first}`).toBeGreaterThan(-1)
  expect(tail, `缺少片段：${second}`).toBeGreaterThan(-1)
  expect(head, `${first} 必须在 ${second} 之前`).toBeLessThan(tail)
}

describe('接线：每条动线在 await 之前抓身份、在写回之前核身份', () => {
  /** 动线名 → 该动线里第一个真正的 `await`（注释里出现的 await 不算） */
  const awaitOf: Record<string, string> = {
    runWithdraw: 'await withdrawDispute(',
    addAttachments: 'await pickPhotos(',
    loadMessages: 'await loadDisputeConversationId(',
    loadOlderEvidence: 'await loadDisputeConversationId(',
    addEvidence: 'await addDisputeEvidence(',
    previewAttachment: 'await loadDisputeDetail(',
  }

  for (const [name, firstAwait] of Object.entries(awaitOf)) {
    test(`${name} 的身份令牌在第一个 await 之前就铸好`, async () => {
      const body = handlerBody(await pageSource(), name)
      expectBefore(body, 'const op = beginOp(', firstAwait)
    })
  }

  test('runWithdraw：await 回来的成功/失败都先核身份，再写详情与提示', async () => {
    const body = handlerBody(await pageSource(), 'runWithdraw')
    expectBefore(body, 'if (!opAlive(op)) return', 'setDetail(next)')
    expectBefore(body, 'if (!opAlive(op)) return', "'已撤回争议'")
    // 发请求用的是令牌里的争议 id，不是 await 之后重新读的 `detail`
    expectBefore(body, 'const op = beginOp(', 'withdrawDispute(op.disputeId)')
    expect(body).not.toContain('withdrawDispute(detail.id)')
  })

  test('撤回确认弹窗：异步确认回调里核「还能不能补材料」，而不是点了就发', async () => {
    const body = handlerBody(await pageSource(), 'onWithdraw')
    expectBefore(body, 'const op = beginOp(', '.then((result) => {')
    expectBefore(body, 'opWritable(op)', 'runWithdraw()')
    expect(body).not.toContain('if (result.confirm) void runWithdraw()')
  })

  test('选图上传：身份在拉起相册之前抓，选完图再核一次才继续', async () => {
    const body = handlerBody(await pageSource(), 'addAttachments')
    expectBefore(body, 'const op = beginOp(', 'await pickPhotos(')
    expectBefore(body, 'await pickPhotos(', 'picked.rejected')
    // 旧写法：epoch 抓在 pickPhotos 之后（选图期间换号 → 新世代被当成「自己的」）
    expect(body).not.toMatch(/const epoch = loadEpoch\.current/)
    expect(body).not.toContain('epoch === loadEpoch.current')
  })

  test('选图上传：整条上传链按「还能补材料」判定，且用令牌里的争议 id', async () => {
    const body = handlerBody(await pageSource(), 'addAttachments')
    expect(body).toContain('const current = () => opWritable(op)')
    expectBefore(body, 'const current = () => opWritable(op)', 'uploadDisputeAttachment(')
    expectBefore(body, 'if (!current()) break', 'setDetail((prev) =>')
    expect(body).toContain('uploadDisputeAttachment(op.disputeId, photo, {')
    // 上传链自己的在途判据也要接上（presign → PUT → confirm 每一步再核）
    expect(body).toContain('isActive: current')
    expect(body).toContain('currentUserId: () => userIdRef.current')
  })

  test('读候选消息：两道 await 之后都收一次，写回前先判归属', async () => {
    const body = handlerBody(await pageSource(), 'loadMessages')
    expectBefore(body, 'if (settleIfStale()) return', 'setMessages(result.messages)')
    expectBefore(body, 'if (settleIfStale()) return', 'setEvidenceState(result.failed')
    // 世代变了要收成可重试态，否则 evidenceState 永远停在 loading（既不重读也不给重试）
    expect(body).toContain('if (opSameAccount(op)) setEvidenceState(')
  })

  test('翻更早：每页回来都先核身份，再拼消息与游标', async () => {
    const body = handlerBody(await pageSource(), 'loadOlderEvidence')
    expectBefore(body, 'if (!opAlive(op)) return', 'setMessages((prev) =>')
    expectBefore(body, 'if (!opAlive(op)) return', 'setEvidenceCursor(result.nextCursor)')
    expectBefore(body, 'if (!opAlive(op)) return', "'更早的消息没读出来，再试一次'")
  })

  test('加证据：写详情、关弹层、弹提示都在归属判定之后', async () => {
    const body = handlerBody(await pageSource(), 'addEvidence')
    expectBefore(body, 'await addDisputeEvidence(', 'if (!opAlive(op)) return')
    expectBefore(body, 'if (!opAlive(op)) return', 'setDetail((prev) =>')
    expectBefore(body, 'if (!opAlive(op)) return', 'setSheetOpen(false)')
    // 失败分支同样先核身份：换号后旧账号的 409 不该在新账号页面上触发重同步
    const catchBlock = sliceBetween(body, '} catch (error) {', '} finally {')
    expectBefore(catchBlock, 'if (!opAlive(op)) return', 'resyncIfConflict(error)')
  })

  test('预览大图：重读回来的旧签名既不写回状态，也不拿去过期账号的证据', async () => {
    const body = handlerBody(await pageSource(), 'previewAttachment')
    expectBefore(body, 'if (!opAlive(op)) return', 'setDetail(result.detail)')
    // 守卫之后才允许用刷新后的 url 打开大图（openWith 的调用点在守卫下方）
    expectBefore(body, 'if (!opAlive(op)) return', 'fresh.map((attachment) => attachment.url)')
    expect(body).toContain('loadDisputeDetail(op.disputeId)')
    expect(body).not.toContain('loadDisputeDetail(detail.id)')
  })

  test('六条动线里不再残留只看 alive 的旧判据', async () => {
    const source = await pageSource()
    for (const name of Object.keys(awaitOf)) {
      const body = handlerBody(source, name)
      expect(body, `${name} 里仍有 if (!alive.current) return`).not.toContain(
        'if (!alive.current) return',
      )
      expect(body, `${name} 里仍有 alive.current ?`).not.toMatch(/alive\.current\s*\?/)
    }
  })
})

describe('收尾：忙位归账号所有，换号清场要放掉在途闩锁', () => {
  test('忙位收尾只判「还是同一账号」，不判世代', async () => {
    const source = await pageSource()
    // 判世代收尾会把同号静默刷新的收尾一并跳过，按钮永久卡在「上传中… / 撤回中…」
    expect(source).toContain(
      'const opSameAccount = (op: OpScope): boolean => opOwnsBusyIn(op, identityNow())',
    )
  })

  test('每条动线的 finally 都用 opSameAccount 收尾，而不是 opAlive', async () => {
    const source = await pageSource()
    for (const name of [
      'runWithdraw',
      'addAttachments',
      'loadMessages',
      'loadOlderEvidence',
      'addEvidence',
    ]) {
      const body = handlerBody(source, name)
      const finallyBlock = body.slice(body.lastIndexOf('finally {'))
      expect(finallyBlock, `${name} 的 finally 没有账号判据`).toContain('opSameAccount(op)')
      expect(finallyBlock, `${name} 的 finally 用世代判据收尾`).not.toContain('opAlive(op)')
      expect(finallyBlock, `${name} 的 finally 仍然只看 alive`).not.toContain('alive.current')
    }
  })

  test('换号清场：清掉两个忙位与在途取数闩锁，并推进世代', async () => {
    const source = await pageSource()
    const block = sliceBetween(source, 'if (prevUserId !== userId) {', 'useEffect(')
    expect(block).toContain('loadEpoch.current += 1')
    expect(block).toContain('ownerEpoch.current += 1')
    expect(block).toContain('withdrawConfirmingRef.current = false')
    expect(block).toContain('setDetail(null)')
    expect(block).toContain('setWithdrawing(false)')
    expect(block).toContain('setUploading(false)')
    expect(block).toContain('evidenceLoadingRef.current = false')
    expect(block).toContain('setLoadingOlderEvidence(false)')
    expect(block).toContain('setAddingMessageId(null)')
  })

  test('旧链的 finally 在换号时跳过，闩锁只能由清场放掉（否则新账号永远读不出候选消息）', async () => {
    const source = await pageSource()
    const loadMessages = handlerBody(source, 'loadMessages')
    // 闩锁的释放受账号判据保护：换号时这里跳过
    const finallyBlock = loadMessages.slice(loadMessages.lastIndexOf('finally {'))
    expectBefore(finallyBlock, 'opSameAccount(op)', 'evidenceLoadingRef.current = false')
    // 所以清场必须自己放一次
    const resetBlock = sliceBetween(source, 'if (prevUserId !== userId) {', 'useEffect(')
    expect(resetBlock).toContain('evidenceLoadingRef.current = false')
  })
})

describe('不回退：409 重同步、分页、幂等去重与 PENDING 权限仍在', () => {
  test('409 仍触发静默重拉（按钮在 stale 期间隐藏，刷新后按新状态重判）', async () => {
    const source = await pageSource()
    const body = sliceBetween(source, 'const resyncIfConflict = ', 'useEffect(')
    expect(body).toContain('error.status !== 409')
    expect(body).toContain('setStale(true)')
    expect(body).toContain('void read(true)')
  })

  test('翻更早仍按游标分页、按 id 去重后前置拼接', async () => {
    const body = handlerBody(await pageSource(), 'loadOlderEvidence')
    expect(body).toContain('loadEvidenceCandidates(conversationId, evidenceCursor)')
    expect(body).toContain('setEvidenceCursor(result.nextCursor)')
    expect(body).toContain('!known.has(message.id)')
    expect(body).toContain('...prev')
  })

  test('附件与证据仍按服务端 id/消息 id 幂等去重（confirm 重放回同一行时不会重复展示）', async () => {
    const source = await pageSource()
    const upload = handlerBody(source, 'addAttachments')
    expect(upload).toContain('prev.attachments.some((item) => item.id === attachment.id)')
    const evidence = handlerBody(source, 'addEvidence')
    expect(evidence).toContain(
      'prev.evidence.some((item) => item.message.id === result.evidence.message.id)',
    )
  })

  test('补材料 / 撤回的入口仍是 PENDING 发起人权限，且上传链按 op 的争议 id 发请求', async () => {
    const source = await pageSource()
    expect(source).toContain('canAddDisputeMaterial(detail, userId)')
    expect(source).toContain('canWithdrawDispute(detail, userId)')
  })

  test('预览仍按签名 URL 的 TTL 决定是否先重读详情', async () => {
    const body = handlerBody(await pageSource(), 'previewAttachment')
    expect(body).toContain('ATTACHMENT_URL_TTL_MS')
    expect(body).toContain('loadDisputeDetail(op.disputeId)')
  })
})
