import type { Run } from './types'

/** 不得出现在片段开头的闭合/句读标点 */
const LEADING_BAN = /^[。，、；：？！）」』》】〕”’%]+/
/** 不得出现在片段结尾的开标点 */
const TRAILING_BAN = /[（「『《【〔“‘]+$/

/**
 * 把落在片段边界上的标点并回它所属的文字。
 *
 * 渲染层把每个 `Run` 渲染成一个独立的嵌套 `<text>`（`components/legal-doc`），
 * 数据里又有 `…教育邮箱（` | `@gzasc.edu.cn` | `）并验证…` 这类切在标点上的边界，
 * 标点于是成了与句子分开的文本盒，断行时句读可能落到行首、开括号可能留在行尾（#515）。
 *
 * - 以闭标点起首的片段：首部的标点并到**前一片段**尾部；
 * - 以开标点结尾的片段：尾部的标点并到**后一片段**首部；
 * - 并入后沿用接收方的 `b` / `em` / `ph` / `k`；掏空的片段（如单独的 `。`）直接丢弃；
 * - 首个片段的首标点、末个片段的尾标点没有可并入的邻居，原样保留。
 */
export function mergeEdgePunctuation(runs: Run[]): Run[] {
  const out: Run[] = []
  let carry = ''
  for (const run of runs) {
    let t = carry + run.t
    carry = ''

    const prev = out[out.length - 1]
    const lead = prev ? LEADING_BAN.exec(t)?.[0] : undefined
    if (prev && lead) {
      prev.t += lead
      t = t.slice(lead.length)
    }

    const tail = TRAILING_BAN.exec(t)?.[0]
    if (tail) {
      carry = tail
      t = t.slice(0, t.length - tail.length)
    }

    if (t !== '') out.push({ ...run, t })
  }

  if (carry) {
    const last = out[out.length - 1]
    if (last) last.t += carry
    else out.push({ t: carry })
  }
  return out
}
