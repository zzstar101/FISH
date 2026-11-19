import { describe, expect, test } from 'bun:test'

/**
 * 登录页协议同意的**默认态与接线**（微信审核驳回整改，2026-11-19）。
 *
 * 审核口径：「默认自动同意《用户服务协议》及《隐私政策》……应当由用户自主阅读后自行选择
 * 是否同意隐私政策协议，不得默认强制用户同意」。落到端上就是一条：登录页进来时勾选框
 * **必须是空的**，用户点一下才算同意。
 *
 * 这条改动没有编译期保护，也没有可渲染的组件测试基建（本仓 `tests/` 只能读源码钉接线，
 * 先例 `tests/back-top-scroll-source.test.ts`）。而它一旦回退，typecheck / lint / 其余测试
 * 全绿，只有提审会再次被驳回 —— 所以这里**切到具体片段再断言**，不查整份文件：
 * 整份文件的子串命中挡不住「守卫里删掉 return」「守卫挪到 Taro.login 之后」
 * 「useDidShow 里又补一句 setAgreed(true)」这类改法。
 */

async function loginSource(): Promise<string> {
  return await Bun.file(new URL('../src/pkg-auth/pages/login/index.tsx', import.meta.url)).text()
}

/** 去掉注释后的源码：本文件的注释里正解释着「默认不勾选」的理由，拿原文断言会自证。 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\r\n/g, '\n')
}

/**
 * 取从 `from` 开始、按花括号配平切出的那一块源码（含 `from` 本身）。
 * 找不到 `from` 时返回空串 —— 让「块被整段删掉」也落红，而不是静默通过。
 */
function block(source: string, from: string): string {
  const start = source.indexOf(from)
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return source.slice(start)
}

describe('登录页协议勾选默认不勾选', () => {
  test('agreed 的初始值是 false', async () => {
    const src = code(await loginSource())
    expect(src).toContain('const [agreed, setAgreed] = useState(false)')
    expect(src, '不得再出现默认勾选').not.toContain('const [agreed, setAgreed] = useState(true)')
  })

  test('勾选是 CTA 的前置条件：未勾选时 CTA 落 is-off 禁用态', async () => {
    const src = code(await loginSource())
    expect(src).toContain('const canWechat = agreed && !wechatBusy')
    // CTA 的 className 必须由 canWechat 决定，而不是恒为品牌色实底
    expect(src).toContain("canWechat ? '' : ' is-off'")
    // 勾选框的可视态必须由 agreed 决定：恒 is-on 等于视觉上一直「已同意」
    expect(src).toContain("agreed ? ' is-on' : ''")
  })

  test('勾选框可以取消：onClick 取反而不是写死 true', async () => {
    const src = code(await loginSource())
    expect(src).toContain('onClick={() => setAgreed((prev) => !prev)}')
  })

  test('未勾选时点击登录：守卫块自己带 return，且整块在 Taro.login 之前', async () => {
    const src = code(await loginSource())
    const guardAt = src.indexOf('if (!agreed) {')
    expect(guardAt, '未勾选守卫被删掉了').toBeGreaterThanOrEqual(0)

    // 关键：切出守卫**这一块**再查 return。整份文件里随便哪个 return 都不能替它作证。
    const guard = block(src, 'if (!agreed) {')
    expect(guard).toContain("toast('请先阅读并同意《用户协议》与《隐私政策》')")
    expect(guard, '守卫块里必须 return，否则提示完照样往下登录').toContain('return')

    // 整块守卫必须排在发起登录之前
    const loginAt = src.indexOf('await Taro.login()')
    expect(loginAt).toBeGreaterThan(guardAt)
    expect(src.slice(guardAt, loginAt)).not.toContain('Taro.login()')
  })

  test('法务页同意条的回传仍然保留 prev：不得在进页面时把勾选改成 true', async () => {
    const src = code(await loginSource())
    // 进页面自动勾上等于又造了一条「默认同意」路径
    expect(src).not.toContain('setAgreed(true)')
    // 回传必须基于用户当前态（丢掉 prev 会让「不同意」把用户原来的勾选抹平）
    expect(src).toContain('setAgreed((prev) => applyConsent(decision, prev))')
  })
})
