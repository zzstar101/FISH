import { describe, expect, test } from 'bun:test'
import {
  beginTask,
  canLoadStatus,
  clearedScope,
  isTaskCurrent,
  ownerChanged,
  type VerifyTask,
} from '../src/pages/verify/view'

/**
 * verify 页账号作用域判据的回归（#170 判据 A/B/C）。
 *
 * 锁的是三类只看单帧状态看不出来的时序：
 * - 冷启动 `authStatus === 'unknown'` 阶段不得打 `GET /verification/status`（三个端点都挂
 *   `requireAuth`，早发必然 401）；
 * - A 的在途发码 / 验码响应（成功、失败、`finally` 解锁）不得落进 B 的页面；
 * - `A → B → A` 时 A 的**旧**响应不得写进 A 的新会话 —— 只比对 ownerId 挡不住这条。
 *
 * 两层：
 * 1. **判据层** —— 直接跑 `view.ts` 的纯函数，锁住「给定状态算出该不该发 / 该不该写」。
 * 2. **接线层** —— 读 `index.tsx` 源码，锁住判据**真的接在页面上**。没有这一层的话
 *    把页面里的 `taskAlive` 守卫、渲染期清场、effect 门禁全删掉，本文件照样全绿
 *    （`view.ts` 还在，判据层就还能过）—— 那正是 #170 要修的东西。仓库没有 Taro 组件
 *    渲染基建，源码断言是既有手法（见 `verify-messages.test.ts` 的「页面接线」用例）。
 *
 * 仍未覆盖：端上真实时序（Taro 运行时渲染期 setState 的时机、弱网下响应的到达顺序）。
 * 那部分按 A/B/C 在微信开发者工具里实测，不拿本文件当端上证明。
 */

/** 一个最小的「页面 + 写任务」模型：只保留跨账号交错需要的字段 */
function page() {
  return { ownerId: null as string | null, epoch: 0, ...clearedScope() }
}

type Page = ReturnType<typeof page>

/** 换账号：渲染期同步清场 + 代次前进（对应 index.tsx 的 `ownerChanged` 分支） */
function switchOwner(p: Page, next: string | null): void {
  if (!ownerChanged(p.ownerId, next)) return
  p.ownerId = next
  p.epoch += 1
  Object.assign(p, clearedScope())
}

/** 页面卸载：在途任务一并作废（对应 index.tsx 的卸载 effect） */
function unmount(p: Page): void {
  p.epoch += 1
}

/** 响应落地：只有任务仍属于当前账号、且这一轮没被作废才允许写入 */
function settle(p: Page, task: VerifyTask, write: () => void): boolean {
  if (!isTaskCurrent(task, p.epoch, p.ownerId)) return false
  write()
  return true
}

describe('verify 页状态加载门禁', () => {
  test('冷启动 unknown 阶段不发受限请求', () => {
    expect(canLoadStatus(false, null)).toBe(false)
  })

  test('已登录但没有 userId 时仍不发（身份未就绪）', () => {
    expect(canLoadStatus(true, null)).toBe(false)
  })

  test('恢复到 authed 且拿到 userId 后才加载', () => {
    expect(canLoadStatus(true, 'user-a')).toBe(true)
  })

  test('退出登录后不再发', () => {
    expect(canLoadStatus(false, 'user-a')).toBe(false)
  })
})

describe('verify 页换号清场', () => {
  test('owner 变化的两个方向都算换号，同号广播不算', () => {
    expect(ownerChanged(null, 'user-a')).toBe(true)
    expect(ownerChanged('user-a', 'user-b')).toBe(true)
    expect(ownerChanged('user-a', null)).toBe(true)
    expect(ownerChanged('user-a', 'user-a')).toBe(false)
    expect(ownerChanged(null, null)).toBe(false)
  })

  test('换号清场覆盖全部账号作用域字段（漏一项就会让 B 继承 A 的界面）', () => {
    expect(clearedScope()).toEqual({
      stage: 'email',
      status: null,
      email: '',
      emailError: '',
      code: '',
      codeError: '',
      left: 0,
      sending: false,
      submitting: false,
    })
  })

  test('换号后页面回到填邮箱阶段，不带 A 的邮箱 / 码 / 倒计时 / 错误与锁', () => {
    const p = page()
    switchOwner(p, 'user-a')
    Object.assign(p, {
      stage: 'code' as const,
      email: 'a@gzasc.edu.cn',
      code: '123456',
      left: 42,
      codeError: '验证码不正确',
      emailError: '该校园邮箱已绑定其他账号',
      sending: true,
      submitting: true,
    })

    switchOwner(p, 'user-b')

    expect(p).toMatchObject({
      ownerId: 'user-b',
      stage: 'email',
      email: '',
      code: '',
      left: 0,
      codeError: '',
      emailError: '',
      sending: false,
      submitting: false,
    })
  })
})

describe('verify 页 owner/epoch 交错', () => {
  test('A 在途发码的成功不得把 B 推进输码阶段、也不得起 A 的倒计时', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, 'user-b')

    const wrote = settle(p, taskA, () => {
      p.stage = 'code'
      p.left = 60
    })
    expect(wrote).toBe(false)
    expect(p.stage).toBe('email')
    expect(p.left).toBe(0)
  })

  test('A 在途发码的失败文案不落进 B 的错误框', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')
    switchOwner(p, 'user-b')

    const wrote = settle(p, taskA, () => {
      p.emailError = '请求过于频繁，请 30 秒后再试'
    })
    expect(wrote).toBe(false)
    expect(p.emailError).toBe('')
  })

  test('A 的 finally 不解锁 B 已经点下的那一次（否则 B 会重复发码）', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, 'user-b')
    const taskB = beginTask(p.epoch, 'user-b')
    p.sending = true

    // A 迟到，走 finally 解锁：必须是 no-op
    settle(p, taskA, () => {
      p.sending = false
    })
    expect(p.sending).toBe(true)

    // B 自己的任务照常落定
    expect(
      settle(p, taskB, () => {
        p.sending = false
      }),
    ).toBe(true)
    expect(p.sending).toBe(false)
  })

  test('A 在途验码的失败不得写进 B，也不得解开 B 的重发倒计时', () => {
    const p = page()
    switchOwner(p, 'user-a')
    p.stage = 'code'
    p.left = 30
    const taskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, 'user-b')
    const taskB = beginTask(p.epoch, 'user-b')
    p.stage = 'code'
    p.left = 30

    settle(p, taskA, () => {
      p.codeError = '验证码已过期，请重新获取'
      p.left = 0
    })
    expect(p.codeError).toBe('')
    expect(p.left).toBe(30)

    expect(
      settle(p, taskB, () => {
        p.codeError = '验证码不正确，请核对后重新输入'
      }),
    ).toBe(true)
    expect(p.codeError).toBe('验证码不正确，请核对后重新输入')
  })

  test('退出登录到 null 也算换 owner，在途任务同样作废', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, null)
    expect(settle(p, taskA, () => undefined)).toBe(false)
  })

  test('A → B → A：A 的旧响应不得写进 A 的新会话（只比 ownerId 会漏这条）', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const staleTaskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, 'user-b')
    switchOwner(p, 'user-a')
    const freshTaskA = beginTask(p.epoch, 'user-a')

    // 账号 id 与当前一致，只有代次能证明它是上一轮的
    expect(staleTaskA.ownerId).toBe('user-a')
    expect(p.ownerId).toBe('user-a')
    expect(settle(p, staleTaskA, () => undefined)).toBe(false)
    expect(settle(p, freshTaskA, () => undefined)).toBe(true)
  })

  test('卸载后迟到响应一律作废', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')

    unmount(p)
    expect(settle(p, taskA, () => undefined)).toBe(false)
  })

  test('同账号内不误伤：没有换号时任务仍然有效', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const task = beginTask(p.epoch, 'user-a')
    expect(settle(p, task, () => undefined)).toBe(true)
  })
})

/** 取 `index.tsx` 里 `from` 到其后第一个 `to` 之间的源码 */
async function pageSlice(from: string, to: string): Promise<string> {
  const code = await Bun.file(new URL('../src/pages/verify/index.tsx', import.meta.url)).text()
  const start = code.indexOf(from)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = code.indexOf(to, start)
  expect(end).toBeGreaterThan(start)
  return code.slice(start, end)
}

/**
 * 接线层：判据写对了不等于页面接对了。
 *
 * 每条断言都对应 #170 的一个修复点，在修复前的 `index.tsx` 上必然失败（已实测：
 * 把本文件配 `git show main:apps/miniapp/src/pages/verify/index.tsx` 跑，接线层全红）。
 * 断言的是**结构**（守卫在不在、清场覆盖哪些 setter），不锁注释与文案，改动实现只要
 * 仍满足判据就不会误伤。
 */
describe('verify 页接线 —— 判据真的接在页面上', () => {
  test('换号在同一帧清场：九个字段逐个 setState + 两个 ref 锁都清', async () => {
    const block = await pageSlice('if (ownerChanged(prevUserId, userId)) {', 'useEffect(')
    for (const setter of [
      'setStage(cleared.stage)',
      'setStatus(cleared.status)',
      'setEmail(cleared.email)',
      'setEmailError(cleared.emailError)',
      'setCode(cleared.code)',
      'setCodeError(cleared.codeError)',
      'setLeft(cleared.left)',
      'setSending(cleared.sending)',
      'setSubmitting(cleared.submitting)',
    ]) {
      expect(block).toContain(setter)
    }
    expect(block).toContain('epochRef.current += 1')
    expect(block).toContain('sendingRef.current = false')
    expect(block).toContain('submittingRef.current = false')
  })

  test('卸载 effect 让代次前进，作废在途的发码 / 验码', async () => {
    const code = await Bun.file(new URL('../src/pages/verify/index.tsx', import.meta.url)).text()
    expect(code).toMatch(/return \(\) => \{\s*epochRef\.current \+= 1\s*\}/)
  })

  test('状态加载走 canLoadStatus 门禁：unknown 不发，且不再在 effect 里无条件清 status', async () => {
    const code = await Bun.file(new URL('../src/pages/verify/index.tsx', import.meta.url)).text()
    expect(code).toContain("if (!canLoadStatus(authStatus === 'authed', userId)) return")
    // 修复前是 `if (authStatus !== 'authed' || !userId) return` + effect 顶部 `setStatus(null)`
    expect(code).not.toMatch(/authStatus !== 'authed' \|\| !userId/)
    expect(code).not.toMatch(/useEffect\(\(\) => \{\s*setStatus\(null\)/)
  })

  test('发码 / 验码的成功与失败都在落地前确认任务仍有效', async () => {
    const code = await Bun.file(new URL('../src/pages/verify/index.tsx', import.meta.url)).text()
    // 成功分支：发码推进阶段、验码写 status，各自前面都要有守卫
    expect(code).toMatch(/if \(!taskAlive\(task\)\) return\s*\n\s*setStage\('code'\)/)
    expect(code).toMatch(/if \(!taskAlive\(task\)\) return\s*\n\s*setStatus\(next\)/)
    // 失败分支：错误文案与倒计时解锁同样要守卫
    expect(code).toMatch(/if \(!taskAlive\(task\)\) return\s*\n\s*if \(isApiError\(error\)\)/)
    expect(code).toMatch(/verifyNeedsResend\(error\.code\)\) setLeft\(0\)/)
  })

  test('finally 只解自己那一轮的锁：旧的 finally 不许无条件解锁', async () => {
    const code = await Bun.file(new URL('../src/pages/verify/index.tsx', import.meta.url)).text()
    expect(code).not.toMatch(/\} finally \{\s*(sendingRef|submittingRef)\.current = false/)
    expect(code).toMatch(
      /\} finally \{\s*(?:\/\/[^\n]*\n\s*)*if \(taskAlive\(task\)\) \{\s*sendingRef\.current = false/,
    )
    expect(code).toMatch(
      /\} finally \{\s*(?:\/\/[^\n]*\n\s*)*if \(taskAlive\(task\)\) \{\s*submittingRef\.current = false/,
    )
  })

  test('ALREADY_VERIFIED 收敛的第二个在途窗口也要确认任务', async () => {
    const code = await Bun.file(new URL('../src/pages/verify/index.tsx', import.meta.url)).text()
    expect(code.match(/&& taskAlive\(task\)/g) ?? []).toHaveLength(2)
  })
})
