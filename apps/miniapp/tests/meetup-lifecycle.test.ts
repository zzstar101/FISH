import { describe, expect, test } from 'bun:test'
import {
  canAcquire,
  classifyConfirmFailure,
  nextConfirmPending,
  nextPendingSync,
  pendingAfterTerminalRefetch,
  playsCompletionFx,
  releaseLock,
  type SubmitLock,
  sequenceSuperseded,
  showSync,
  writeLandedSince,
} from '../src/pkg-trade/pages/transaction-meetup/view'

/**
 * transaction-meetup 页的时序回归（#147 P2 与 #170 D 的判据层）。
 *
 * 锁的是四条「只在时序上出错、单看一帧状态看不出来」的行为：
 * - 核销成功后自动 confirm 拿到 409 `TRANSACTION_NOT_IN_PENDING`（核销那一瞬对方取消
 *   或另一侧已确认）—— 旧接线不看错误码，一律 `setConfirmPending(true)`，于是
 *   CANCELLED 的单子继续显示「还差最后一步确认」；
 * - 同一个 tick 连点两下确认 —— 旧接线用 `submitting` state 判重入，第二下读到的还是
 *   上一帧的 `false`，两次请求都发出去；
 * - A 的操作链在飞时换到 B，B 已持锁，A 迟到的 `finally` 把 B 的锁放掉 —— 于是 B 的
 *   页面同 tick 又能再发一次；
 * - 从扫码页返回面交页时本代次有写入在飞 —— 立刻重读会把页面拉回写入前的快照；
 * - 同一账号内连续两次返回刷新响应反序 —— 先发的那次回来时账号代次与本页写入序号
 *   都没变（期间只有对方动了这笔交易），旧快照会把刚读到的终态盖回 PENDING_MEETUP
 *   （审查 R6）；
 * - 一次写入**尝试**以网络失败收尾、但页面一次都没被改写过（核销请求本身就没成功）后返回
 *   面交页 —— 旧接线按取锁时自增的尝试序号判新旧，把这次返回刷新整份丢弃，页面停在写入前
 *   的旧快照（#296 发现 1）；反过来，写链已经落定过页面（写回交易快照、换成「确认完成
 *   面交」重试入口、或落到加载失败态）时，迟到的写入前快照必须继续被丢弃，否则会把已
 *   CONSUMED 的凭证打回 6 位码输入态、或把失败卡整张撤销（#296 落地口径审查）；核销撞上
 *   终态、重读又失败时停在输入态（#296 发现 3）。
 *
 * 边界：本文件只跑判据，不跑组件接线（ref 赋值时机、`useDidShow` 注册顺序、渲染期
 * setState）。那部分必须在微信开发者工具里按双账号时序实测，不拿本文件当端上证明。
 */

describe('meetup 自动 confirm 的终态分类（#147 P2）', () => {
  test('409 TRANSACTION_NOT_IN_PENDING 归为终态：重读终态并撤下确认入口', () => {
    expect(classifyConfirmFailure('TRANSACTION_NOT_IN_PENDING')).toBe('terminal')
  })

  test('网络等其它失败仍回到可重试的确认入口', () => {
    expect(classifyConfirmFailure('NETWORK_ERROR')).toBe('retry')
    expect(classifyConfirmFailure(null)).toBe('retry')
  })

  test('终态分支不得把页面留在「还差最后一步确认」', () => {
    // 核销后自动 confirm 拿到 409 → 交易已终态，确认入口必须撤下。
    // 走真实导出（index.tsx 的两个 catch 都调它），改坏判定这里就红。
    expect(
      nextConfirmPending({
        kind: 'error',
        failure: classifyConfirmFailure('TRANSACTION_NOT_IN_PENDING'),
      }),
    ).toBe(false)

    // COMPLETED：另一侧已确认，同样不得停在待确认
    expect(nextConfirmPending({ kind: 'ok', status: 'COMPLETED' })).toBe(false)

    // 还差另一侧：入口继续候着
    expect(nextConfirmPending({ kind: 'ok', status: 'PENDING_MEETUP' })).toBe(true)

    // 网络失败：保留入口供重试，不假装已完成
    expect(
      nextConfirmPending({ kind: 'error', failure: classifyConfirmFailure('NETWORK_ERROR') }),
    ).toBe(true)
    expect(nextConfirmPending({ kind: 'error', failure: classifyConfirmFailure(null) })).toBe(true)

    // CANCELLED：今天靠渲染门兜住（cancelled 状态卡优先），判据本身也不能说要留
    expect(nextConfirmPending({ kind: 'ok', status: 'CANCELLED' })).toBe(false)
  })

  test('409 之后重读：只有读到仍是待面交才保留确认入口', () => {
    // 读到了终态：撤下入口，落到对应状态卡
    expect(pendingAfterTerminalRefetch({ status: 'CANCELLED' })).toBe(false)
    expect(pendingAfterTerminalRefetch({ status: 'COMPLETED' })).toBe(false)

    // 读不到（网络抖动 / 5xx）：同样撤下 —— 409 已确证交易不是待面交，保留入口会让
    // 已取消的单子继续显示「还差最后一步确认」。调用点会连同旧快照一起丢掉、落到
    // 「加载失败 + 重试」，而不是照旧快照渲染 6 位码输入态（凭证已 CONSUMED）。
    expect(pendingAfterTerminalRefetch(null)).toBe(false)

    // 与 409 自相矛盾，但凭证必定已消耗：保留入口至少还能重试确认
    expect(pendingAfterTerminalRefetch({ status: 'PENDING_MEETUP' })).toBe(true)
  })
})

describe('meetup 完成动效的触发口径（Owner 拍板）', () => {
  test('在途操作里重读到 COMPLETED 就播 —— 含自动 confirm 撞上「对方已确认」的 409 冲突路径', () => {
    expect(playsCompletionFx('COMPLETED')).toBe(true)
  })

  test('CANCELLED 与「还差另一侧」都不播', () => {
    expect(playsCompletionFx('CANCELLED')).toBe(false)
    expect(playsCompletionFx('PENDING_MEETUP')).toBe(false)
  })

  test('重读失败（拿不到状态）不播：不能假装交易已完成', () => {
    expect(playsCompletionFx(null)).toBe(false)
  })
})

/** 最小「提交锁 + 账号代次」模型：对应 index.tsx 的 submitLock ref 与 bootEpoch */
function lockbox() {
  return { holder: null as SubmitLock, epoch: 0 }
}

/** 换账号：渲染期同步自增代次（index.tsx 的 identityRef 分支） */
function switchAccount(box: ReturnType<typeof lockbox>) {
  box.epoch += 1
  return box.epoch
}

/** 发起一次提交：取到锁才放行 */
function tryBegin(box: ReturnType<typeof lockbox>) {
  if (!canAcquire(box.holder, box.epoch)) return false
  box.holder = box.epoch
  return true
}

/** 操作链收尾：释放锁并返回释放后的持有者 */
function end(box: ReturnType<typeof lockbox>, epoch: number) {
  box.holder = releaseLock(box.holder, epoch)
  return box.holder
}

describe('meetup 同步提交锁（#147 P2）', () => {
  test('同一个 tick 连点两下只放行一次', () => {
    const box = lockbox()
    expect(tryBegin(box)).toBe(true)
    expect(tryBegin(box)).toBe(false)
  })

  test('换账号后旧链的 finally 不得释放新账号手里的锁', () => {
    const box = lockbox()
    expect(tryBegin(box)).toBe(true)
    const epochA = box.epoch

    // A 还在飞时换到 B，B 立刻开始自己的提交
    const epochB = switchAccount(box)
    expect(tryBegin(box)).toBe(true)

    // A 的 finally 迟到
    expect(end(box, epochA)).toBe(epochB)
    // 锁仍在 B 手里：B 同 tick 再点依旧被挡
    expect(tryBegin(box)).toBe(false)

    // B 自己收尾才真正释放
    expect(end(box, epochB)).toBe(null)
    expect(tryBegin(box)).toBe(true)
  })

  test('释放后同代次可以再次提交（重试入口不被锁卡死）', () => {
    const box = lockbox()
    expect(tryBegin(box)).toBe(true)
    expect(end(box, box.epoch)).toBe(null)
    expect(tryBegin(box)).toBe(true)
  })
})

describe('meetup 返回刷新（#170 D）', () => {
  test('首次 show 让渡给登录态 effect（不双发）', () => {
    expect(
      showSync({ firstShow: true, authed: true, userId: 'user-a', submitInFlight: false }),
    ).toBe('skip')
  })

  test('非首次 show 且身份有效时立刻重同步', () => {
    expect(
      showSync({ firstShow: false, authed: true, userId: 'user-a', submitInFlight: false }),
    ).toBe('sync')
  })

  test('本代次有写入在飞时挂起，等写链收尾后补一次（不丢刷新）', () => {
    expect(
      showSync({ firstShow: false, authed: true, userId: 'user-a', submitInFlight: true }),
    ).toBe('defer')
  })

  test('退出登录 / 身份未就绪时返回不发受限请求', () => {
    expect(showSync({ firstShow: false, authed: false, userId: null, submitInFlight: false })).toBe(
      'skip',
    )
    expect(showSync({ firstShow: false, authed: true, userId: null, submitInFlight: false })).toBe(
      'skip',
    )
  })

  test('挂起标记：旧链收尾不补同步，也不清掉新账号的挂起标记（不丢刷新）', () => {
    // 旧账号（代次 0）的写链收尾迟到，此时当前代次已是 1：
    // 既不补同步，也不许把标记清掉 —— 清了新账号那次刷新就永远丢了
    expect(nextPendingSync(true, 0, 1)).toEqual({ sync: false, pending: true })

    // 新账号自己的写链收尾：补一次并清标记
    expect(nextPendingSync(true, 1, 1)).toEqual({ sync: true, pending: false })

    // 没有挂起就什么都不做
    expect(nextPendingSync(false, 1, 1)).toEqual({ sync: false, pending: false })
    expect(nextPendingSync(false, 0, 1)).toEqual({ sync: false, pending: false })
  })

  test('同步窗口内有写入**落地**时才丢弃这份旧快照（不把 COMPLETED 倒回待确认）', () => {
    // 窗口内没有写入落地：快照就是最新的，可以落地
    expect(writeLandedSince(3, 3)).toBe(false)

    // 窗口内写完了一次并放掉锁：这时「有没有人持锁」是空的，只有序号能看出来。
    // 落地就会用写入前的快照把刚写成的 COMPLETED 盖回 PENDING_MEETUP。
    expect(writeLandedSince(3, 4)).toBe(true)
  })
})

/**
 * #296 发现 1：返回刷新的丢弃判据是「这份快照发出后有没有写入**真正落地**」，不是「有
 * 没有人**尝试**过写入」。`writeSeq` 在取锁那一瞬就自增，而一条写链可能以网络失败收尾
 * （confirm 超时 / 核销被拒 / 终态重读也失败），页面状态一次都没被写过 —— 按尝试序号
 * 丢弃，用户从扫码页返回时看到的还是写入前的旧快照，返回刷新等于没有。
 */
describe('meetup 返回刷新：只认真正落地的写入（#296 发现 1）', () => {
  test('写入尝试以网络失败收尾时，这份返回快照必须落地', () => {
    // 时序：快照发出时尝试序号 3；期间 verify 取到提交锁（尝试序号 → 4），随后 confirm
    // 网络失败收尾，一次 setTx(dto) 都没有落地（落地序号仍是 3）。
    // 旧判据 sequenceSuperseded(seenWrites, writeSeq.current) 在这里把快照丢掉：
    expect(sequenceSuperseded(3, 4)).toBe(true)
    // 修复后的判据必须放行 —— 页面状态没被写过，服务端读回来的才是最新的：
    expect(writeLandedSince(3, 3)).toBe(false)
  })

  test('窗口内真正落地过一次写入时仍然丢弃（不回归 #147 审查 F2）', () => {
    // 快照发出时尝试序号 3；尝试 4 落地，页面已经是写入后的状态
    expect(writeLandedSince(3, 4)).toBe(true)
  })

  test('先落过一次、最后一次尝试失败：同样丢弃，不把已落地的结果倒回', () => {
    // 快照发出时尝试序号 5；尝试 6 落地（页面已是写入后的状态）；尝试 7 取锁后网络失败。
    // 「最后一次尝试没落地」不等于「窗口内没有落地」—— 只比最后一次尝试会放行这份旧
    // 快照，把尝试 6 写成的 COMPLETED 倒回 PENDING_MEETUP（#147 审查 F2 的同一个坑）。
    expect(writeLandedSince(5, 6)).toBe(true)
  })
})

/**
 * 最小「返回读取任务」模型：对应 index.tsx 的 `showReadSeq` ref 与 `syncOnShow` 的两段
 * await（交易读取 → 凭证状态读取）。每个动作都走真实导出（`sequenceSuperseded`），判据被
 * 改坏这里就红；组件接线本身（什么时候自增、在哪几个 await 之后校验）仍只在开发者工具里
 * 实测 —— 与上面的 `lockbox` 同一取舍。
 */
function reader() {
  return { seq: 0, tx: null as string | null, confirmPending: false }
}

/** 发起一次返回读取：发请求**之前**同步取自增的序号（`syncOnShow` 开头） */
function beginRead(r: ReturnType<typeof reader>) {
  r.seq += 1
  return r.seq
}

/** 一段 await 之后，这次读取的结果还能不能落地 */
function canLand(r: ReturnType<typeof reader>, readId: number) {
  return !sequenceSuperseded(readId, r.seq)
}

/** 落地一份交易快照；已被更新的读取超越时按接线里的行为整份丢弃 */
function land(r: ReturnType<typeof reader>, readId: number, status: string) {
  if (!canLand(r, readId)) return false
  r.tx = status
  r.confirmPending = status === 'PENDING_MEETUP'
  return true
}

describe('meetup 返回读取的响应顺序（审查 R6）', () => {
  test('同账号两次返回反序完成：先发的旧快照不得盖掉后读到的终态', () => {
    const r = reader()
    // 第一次返回：此刻交易还待面交，请求已发出、响应未回
    const first = beginRead(r)
    // 期间只有**对方**动了这笔交易（取消）；本页一次写入都没有，账号代次与写入序号
    // 都不会变 —— 所以「有没有人持锁」「写入序号对不对」两个守卫全都放行
    // 用户再次返回，第二次读取接管
    const second = beginRead(r)

    // 第二次先到：落到 CANCELLED
    expect(land(r, second, 'CANCELLED')).toBe(true)
    expect(r.tx).toBe('CANCELLED')
    expect(r.confirmPending).toBe(false)

    // 第一次后到：只有读取序号能认出它已经过期
    expect(canLand(r, first)).toBe(false)
    expect(land(r, first, 'PENDING_MEETUP')).toBe(false)
    expect(r.tx).toBe('CANCELLED') // 终态没被倒回
    expect(r.confirmPending).toBe(false) // 「还差最后一步确认」没被复活
  })

  test('第一次读取的第二段（凭证状态）迟到时同样不得改状态', () => {
    const r = reader()
    const first = beginRead(r)
    // 第一段通过：交易仍是待面交，且买家已确认、卖家已盖，于是继续查凭证状态
    expect(land(r, first, 'PENDING_MEETUP')).toBe(true)

    // 第二段在飞期间又返回了一次，第二次读到了终态并落地
    const second = beginRead(r)
    expect(land(r, second, 'COMPLETED')).toBe(true)

    // 第一次的凭证状态这时才回来：它属于那一次读取，不能再去改确认入口
    expect(canLand(r, first)).toBe(false)
    expect(r.tx).toBe('COMPLETED')
  })

  test('顺序正常的两次返回照常落地（守卫不误杀）', () => {
    const r = reader()
    const first = beginRead(r)
    expect(land(r, first, 'PENDING_MEETUP')).toBe(true)
    expect(r.confirmPending).toBe(true)

    // 第一次已经收尾，第二次返回是全新的一次读取，必须能落地
    const second = beginRead(r)
    expect(land(r, second, 'CANCELLED')).toBe(true)
    expect(r.tx).toBe('CANCELLED')
    expect(r.confirmPending).toBe(false)
  })

  test('读取序号与写入序号互不替代：合并成一个计数器就漏掉一半', () => {
    const r = reader()
    const first = beginRead(r)

    // 一次本页写入落定（写链自己把最新 DTO 落到页面）：读取序号没动，
    // 光看读取序号会以为这份旧快照还能落地
    expect(canLand(r, first)).toBe(true)
    // 只有**落地**的写入序号能证明它旧了（取锁时自增的尝试序号不算，见 #296 发现 1）
    expect(writeLandedSince(3, 4)).toBe(true)

    // 反过来：新的返回读取不推进写入序号 —— 那次写入的结果不受影响
    const second = beginRead(r)
    expect(canLand(r, first)).toBe(false) // 读取序号认出第一次已过期
    expect(canLand(r, second)).toBe(true)
  })
})

/* --------------------------------------------------------- 页面接线（钉源码） */

/**
 * 判据层测不到「哪个 ref 在哪儿更新、守卫拿哪个 ref 比较」，而这两处正是 #296 的修复点
 * 本身（写链有没有真的落地、守卫比的是尝试序号还是落地序号、409 重读失败后落到哪儿）。
 * 沿用 `tests/history-wiring.test.ts` 的先例，把页面接线钉成断言。
 *
 * 边界照旧：这只是静态检查，替代不了微信开发者工具里的双账号时序实测。
 */
async function meetupPageSource(): Promise<string> {
  return Bun.file(
    new URL('../src/pkg-trade/pages/transaction-meetup/index.tsx', import.meta.url),
  ).text()
}

/** 取 `start` 到 `end` 之间的那段源码；两个锚点都必须存在 */
function sliceFrom(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from).toBeGreaterThanOrEqual(0)
  const to = source.indexOf(end, from)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe('meetup 接线：写入落地序号（#296 发现 1）', () => {
  test('返回刷新的两处写入守卫都比**落地**序号，不再比取锁时自增的尝试序号', async () => {
    const code = await meetupPageSource()
    const sync = sliceFrom(
      code,
      'const syncOnShow = async (epoch: number) => {',
      'const flushPendingSync = (epoch: number) => {',
    )
    // 两段 await 之后各校验一次
    expect(
      sync.match(/if \(writeLandedSince\(seenWrites, landedSeq\.current\)\) return/g),
    ).toHaveLength(2)
    // 捕获源必须是**尝试**序号：改成 landedSeq.current 会让判据恒为 false（回到 #147 审查 F2
    // 的坑 —— 写入前发出的快照盖掉刚写成的 COMPLETED），而上面两条断言仍全绿
    expect(sync).toContain('const seenWrites = writeSeq.current')
    // 尝试序号在取锁那一瞬就自增：拿它判会把「写入以网络失败收尾」也当成写过
    expect(sync).not.toContain('sequenceSuperseded(seenWrites, writeSeq.current)')
  })

  test('落定序号只在写链真正改过页面时跟上，取锁 / 输入错误分支都不许动它', async () => {
    const code = await meetupPageSource()
    // 「改过页面」与「记下这次真的改过」必须成对：只做前者，返回刷新会把这份结果盖回去；
    // 只做后者，页面停在旧快照而刷新被丢弃。落定统一走 landPage，两类调用点：
    // 写回交易快照（landWrite，五个：核销成功落地、verify 内层终态重读成功、verify 外层
    // 409 重读成功、retryConfirm 成功、retryConfirm 终态重读成功）、写链收尾落定恢复态 /
    // 失败态（见下一条用例）。
    expect(code.match(/^\s*landWrite\(dto\)$/gm)).toHaveLength(5)
    // 序号更新只有一处，就在 landPage 里面
    expect(code.match(/landedSeq\.current = writeSeq\.current/g)).toHaveLength(1)
    const pageHelper = sliceFrom(code, 'const landPage = () => {', '\n  }')
    expect(pageHelper).toContain('landedSeq.current = writeSeq.current')
    const writeHelper = sliceFrom(code, 'const landWrite = (dto: TransactionDto) => {', '\n  }')
    expect(writeHelper).toContain('setTx(dto)')
    expect(writeHelper).toContain('landPage()')
    // 两条写链里不许再出现裸 setTx(dto)：绕过 landWrite 就等于序号不跟上，发现 1 回归
    const verifyFn = sliceFrom(
      code,
      'const verify = async (',
      '/** 核销成功但 confirm 尚未落定（网络失败）时的重试入口 */',
    )
    const retryFn = sliceFrom(
      code,
      'const retryConfirm = async (epoch: number) => {',
      '/* --------------------------------------- 返回本页：与服务端重同步（#170 D） */',
    )
    expect(verifyFn).not.toContain('setTx(dto)')
    expect(retryFn).not.toContain('setTx(dto)')
    expect(verifyFn).toContain('landWrite(dto)')
    expect(retryFn).toContain('landWrite(dto)')
  })

  test('写链收尾落定的恢复态 / 失败态也记序号，迟到的写入前快照不许把它们撤销', async () => {
    const code = await meetupPageSource()
    const verifyFn = sliceFrom(
      code,
      'const verify = async (',
      '/** 核销成功但 confirm 尚未落定（网络失败）时的重试入口 */',
    )
    const retryFn = sliceFrom(
      code,
      'const retryConfirm = async (epoch: number) => {',
      '/* --------------------------------------- 返回本页：与服务端重同步（#170 D） */',
    )
    // 核销成功、只有 confirm 网络失败：页面换成「确认完成面交」重试入口，而凭证已被
    // CONSUMED。这份恢复态必须记序号 —— 否则写入前发出的返回读取迟到时会撤下入口、把人
    // 打回 6 位码输入态（入口能否靠凭证状态自愈没有保证，见 view.ts:writeLandedSince）。
    const retryEntry = sliceFrom(
      verifyFn,
      "setConfirmPending(nextConfirmPending({ kind: 'error', failure }))",
      '\n      }',
    )
    expect(retryEntry).toContain('landPage()')
    // retryConfirm 重试又网络失败：入口保持原样，同样是写链建立的恢复态
    const retryFailed = sliceFrom(
      retryFn,
      "Taro.showToast({ title: '确认失败，请稍后重试', icon: 'none' })",
      '\n    } finally {',
    )
    expect(retryFailed).toContain('landPage()')
    // 三处「丢掉不可信旧快照、落到加载失败态」同样要记序号，且都走 landFailed（成对）
    expect(code.match(/^\s*landFailed\(\)$/gm)).toHaveLength(3)
    const failedHelper = sliceFrom(code, 'const landFailed = () => {', '\n  }')
    expect(failedHelper).toContain('setTx(null)')
    expect(failedHelper).toContain("setLoadError('failed')")
    expect(failedHelper).toContain('landPage()')
    // 反向：核销请求本身失败（页面只多了一条输入错误、没被改写过）时**不落定** ——
    // 这正是验收 3 要放行的窗口，多记一次序号就会把该落地的返回刷新又吞掉。
    const messageAt = verifyFn.indexOf('const message = map[error.code]')
    expect(messageAt).toBeGreaterThanOrEqual(0)
    const inputErrorTail = verifyFn.slice(messageAt)
    expect(inputErrorTail).not.toContain('landPage')
    expect(inputErrorTail).not.toContain('landFailed')
  })
})

describe('meetup 接线：409 重读失败的回退（#296 发现 3）', () => {
  test('核销撞上终态、重读又失败时，按同款口径丢旧快照落到失败态', async () => {
    const code = await meetupPageSource()
    const outerCatch = sliceFrom(
      sliceFrom(
        code,
        'const verify = async (',
        '/** 核销成功但 confirm 尚未落定（网络失败）时的重试入口 */',
      ),
      'MEETUP_TOKEN_INVALID',
      "setInputError('核销失败，请检查网络后重试。')",
    )
    // 409 已确证交易离开了 PENDING_MEETUP，但重读失败时拿不到是哪种终态 —— 旧快照
    // （PENDING_MEETUP + 6 位码输入态）两种渲染都不可信，必须和 verify 内层 /
    // retryConfirm 一样落到「加载失败」，不能什么都不做地停在输入态。
    const branch = sliceFrom(
      outerCatch,
      "if (error.code === 'TRANSACTION_NOT_IN_PENDING') {",
      'setConfirmPending(false)',
    )
    expect(branch).toContain('landWrite(dto)')
    // 丢快照 + 落到失败态必须成对（landFailed 里同时记落定序号）：只丢快照不记序号，
    // 写入前发出的返回读取迟到时会用旧 PENDING_MEETUP 把这张失败卡整张撤销。
    expect(branch).toContain('landFailed()')
  })
})
