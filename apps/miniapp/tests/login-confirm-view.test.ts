import { describe, expect, test } from 'bun:test'
import {
  DEMO_LOGIN_TICKET,
  parseLoginLaunch,
  resolveLoginLaunch,
} from '../src/pages/login-confirm/view'

/**
 * 扫码登录确认页的启动参数解析。
 *
 * 两个入口（见 `view.ts` 文件头）：
 * - **真实入口**是 scene 里的裸票据 —— #229 的 `router.ts` 出码时
 *   `scene: ticket`，ticket 是 16 随机字节的 base64url（22 字符，`ScanTicketSchema`）。
 *   这里的用例按**同一形状**构造（`base64url(16 bytes)`），不用手写假串：
 *   `t=<ticket>` 那种临时包装不是真实出码形状，拿它当 fixture 测不出真实入口。
 * - **显式 `ticket` 参数**是演示与页内跳转入口，与 scene 同一套校验。
 *
 * 取不到合法票号必须落「无效登录码」态，不能拿空票 / 任意文本去确认。
 */

/** 与 #229 `ScanTicketSchema` 同源：16 随机字节 → base64url 22 字符。固定字节让用例可复现。 */
function realTicket(seed: number): string {
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => (seed + i * 7) % 256)
  return Buffer.from(bytes).toString('base64url')
}

const TICKET = realTicket(0)
const OTHER_TICKET = realTicket(200)

describe('真实入口：scene 里的裸票据（#229 出码形状）', () => {
  test('fixture 本身就是 22 字符 base64url（先自证形状没写错）', () => {
    expect(TICKET).toHaveLength(22)
    expect(TICKET).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(OTHER_TICKET).toHaveLength(22)
    expect(OTHER_TICKET).not.toBe(TICKET)
  })

  test('后端生成器出来的 scene 原样进入 → 恢复同一张票', () => {
    expect(parseLoginLaunch({ scene: TICKET })).toEqual({ ticket: TICKET })
  })

  test('scene 经百分号编码后进入 → 恢复同一张票', () => {
    expect(parseLoginLaunch({ scene: encodeURIComponent(TICKET) })).toEqual({ ticket: TICKET })
  })

  test('scene 里带真的百分号转义（%41 → A）也能解码出票', () => {
    // base64url 字符集在 encodeURIComponent 下原样不变，所以上一个用例其实没走到解码；
    // 这条用 `%41` 让 `decodeURIComponent` 真的改变字符串，覆盖解码路径。
    const escaped = `%41${'B'.repeat(21)}`
    const decoded = `A${'B'.repeat(21)}`
    expect(decoded).toHaveLength(22)
    expect(parseLoginLaunch({ scene: escaped })).toEqual({ ticket: decoded })
  })

  test('票据里的 - / _ 原样进入也还原（base64url 的合法字符）', () => {
    const withSymbols = 'a-b_c-d_e-f_g_h-i_j0_8'
    expect(withSymbols).toHaveLength(22)
    expect(parseLoginLaunch({ scene: withSymbols })).toEqual({ ticket: withSymbols })
  })

  test('坏长度 / 坏字符 / 非法 scene 一律 null', () => {
    expect(parseLoginLaunch({ scene: TICKET.slice(0, 21) })).toBeNull() // 21 字符
    expect(parseLoginLaunch({ scene: `${TICKET}a` })).toBeNull() // 23 字符
    expect(parseLoginLaunch({ scene: `${'a'.repeat(21)}!` })).toBeNull() // 非法字符
    expect(parseLoginLaunch({ scene: `t%3D${TICKET}` })).toBeNull() // 临时 t= 包装已不是真实形状
    expect(parseLoginLaunch({ scene: 'hello' })).toBeNull()
    expect(parseLoginLaunch({ scene: '' })).toBeNull()
  })
})

describe('显式 ticket 入口：与 scene 同一套合法性校验', () => {
  test('合法票据直达，且原样返回（不做任何改写）', () => {
    expect(parseLoginLaunch({ ticket: TICKET })).toEqual({ ticket: TICKET })
    expect(parseLoginLaunch({ ticket: OTHER_TICKET })).toEqual({ ticket: OTHER_TICKET })
  })

  test('任意非空文本不算票据 —— 否则「无效登录码」态永远走不到', () => {
    expect(parseLoginLaunch({ ticket: 'tk_abc123' })).toBeNull()
    expect(parseLoginLaunch({ ticket: '   ' })).toBeNull()
    expect(parseLoginLaunch({ ticket: `t=${TICKET}` })).toBeNull()
  })

  /**
   * `ScanTicketSchema` 是 `z.string().regex(/^[A-Za-z0-9_-]{22}$/)`，**没有 trim**：
   * 前后带空白的字符串后端永远不会签发。本地若先 trim 再匹配，等于把「合法票据」
   * 的集合放得比契约宽 —— 这种值会进确认态，而真实链路一定失败（#258 复查）。
   */
  test('前后带空白的票据不算合法（本地规则不得宽于契约）', () => {
    expect(parseLoginLaunch({ ticket: ` ${TICKET} ` })).toBeNull()
    expect(parseLoginLaunch({ ticket: `${TICKET}\n` })).toBeNull()
    expect(parseLoginLaunch({ scene: ` ${TICKET} ` })).toBeNull()
  })

  test('两个入口同时给：显式参数优先', () => {
    expect(parseLoginLaunch({ ticket: TICKET, scene: OTHER_TICKET })).toEqual({ ticket: TICKET })
  })

  test('显式参数不合法时不回退到 scene（不猜用户的意图）', () => {
    expect(parseLoginLaunch({ ticket: 'nope', scene: OTHER_TICKET })).toBeNull()
  })

  test('两个入口都没有时返回 null', () => {
    expect(parseLoginLaunch({})).toBeNull()
    expect(parseLoginLaunch({ other: 'x' })).toBeNull()
  })
})

describe('入口判定 resolveLoginLaunch（解析 + 演示构建补票）', () => {
  test('真实构建：参数解析说了算，没有补票', () => {
    expect(resolveLoginLaunch({}, false)).toBeNull()
    expect(resolveLoginLaunch({ scene: TICKET }, false)).toEqual({ ticket: TICKET })
    expect(resolveLoginLaunch({ scene: 'hello' }, false)).toBeNull()
  })

  test('演示构建：入口什么都没给才补演示票，且票号过真实形状门禁', () => {
    expect(resolveLoginLaunch({}, true)).toEqual({ ticket: DEMO_LOGIN_TICKET })
    expect(parseLoginLaunch({ ticket: DEMO_LOGIN_TICKET })).toEqual({ ticket: DEMO_LOGIN_TICKET })
    expect(parseLoginLaunch({ scene: DEMO_LOGIN_TICKET })).toEqual({ ticket: DEMO_LOGIN_TICKET })
  })

  /**
   * 补票**只在入口为空时**发生：带了非法票号仍必须落「无效登录码」，
   * 否则演示构建里任意文本都能确认，页面唯一的失败态就演示不出来了。
   */
  test('演示构建：带了非法票据仍落无效码（补票不掩盖失败态）', () => {
    expect(resolveLoginLaunch({ ticket: 'nope' }, true)).toBeNull()
    expect(resolveLoginLaunch({ scene: 'hello' }, true)).toBeNull()
    expect(resolveLoginLaunch({ scene: `t%3D${TICKET}` }, true)).toBeNull()
  })

  test('演示构建：带了合法票据就用它，不覆盖成演示票', () => {
    expect(resolveLoginLaunch({ scene: TICKET }, true)).toEqual({ ticket: TICKET })
    expect(resolveLoginLaunch({ ticket: OTHER_TICKET }, true)).toEqual({ ticket: OTHER_TICKET })
  })
})
