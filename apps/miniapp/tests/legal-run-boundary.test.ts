import { describe, expect, test } from 'bun:test'
import { COMMUNITY_GUIDELINES_DOC } from '../src/features/legal/community-guidelines'
import { INFO_COLLECTION_DOC } from '../src/features/legal/info-collection'
import { PRIVACY_DOC } from '../src/features/legal/privacy'
import { mergeEdgePunctuation } from '../src/features/legal/runs'
import { TERMS_DOC } from '../src/features/legal/terms'
import { THIRD_PARTY_SHARING_DOC } from '../src/features/legal/third-party-sharing'
import type { Block, LegalDoc, Run } from '../src/features/legal/types'

/**
 * #515：每个 Run 渲染成独立 `<text>`，标点若独占片段边界，断行时会落到行首/行尾。
 * `mergeEdgePunctuation` 在渲染前把边界标点并回它所属的文字。
 */

const CLOSING = '。，、；：？！）」』》】〕”’%'
const OPENING = '（「『《【〔“‘'

function collectBlockRuns(block: Block, out: Run[][]): void {
  if (block.kind === 'list') {
    for (const item of block.items) out.push(item.name, item.use)
    return
  }
  out.push(block.runs)
}

function collectDocRuns(doc: LegalDoc): Run[][] {
  const out: Run[][] = [...doc.meta, ...doc.footNote]
  if (doc.brief) out.push(doc.brief.lead, ...doc.brief.items)
  if (doc.callout) out.push(doc.callout.runs)
  for (const sec of doc.sections) for (const block of sec.blocks) collectBlockRuns(block, out)
  return out
}

const DOCS: LegalDoc[] = [
  TERMS_DOC,
  PRIVACY_DOC,
  INFO_COLLECTION_DOC,
  THIRD_PARTY_SHARING_DOC,
  COMMUNITY_GUIDELINES_DOC,
]

/** 逐字符展开为 [字符, 样式]，用来比较合并前后每个字的样式有没有变 */
function perChar(runs: Run[]): [string, string][] {
  return runs.flatMap((r) => [...r.t].map((ch): [string, string] => [ch, `${r.b}|${r.em}|${r.ph}`]))
}

describe('mergeEdgePunctuation', () => {
  test('闭标点并到前一片段尾部，开标点并到后一片段首部，样式跟接收方', () => {
    const merged = mergeEdgePunctuation([
      { t: '教育邮箱（' },
      { t: '@gzasc.edu.cn', em: true },
      { t: '）并验证' },
    ])
    expect(merged).toEqual([
      { t: '教育邮箱' },
      { t: '（@gzasc.edu.cn）', em: true },
      { t: '并验证' },
    ])
  })

  test('独占片段的句号并入前一片段（随其加粗）并被丢弃', () => {
    const merged = mergeEdgePunctuation([
      { t: '你可随时注销' },
      { t: '自助申请注销', b: true },
      { t: '。' },
    ])
    expect(merged).toEqual([{ t: '你可随时注销' }, { t: '自助申请注销。', b: true }])
  })

  test('中间被掏空的片段与连续标点', () => {
    // 开标点并入后一片段首部；该片段首部不再是闭标点，无需再并回前一片段
    expect(mergeEdgePunctuation([{ t: 'A' }, { t: '（' }, { t: '）B' }])).toEqual([
      { t: 'A' },
      { t: '（）B' },
    ])
  })

  test('没有邻居可并入时原样保留', () => {
    expect(mergeEdgePunctuation([{ t: '，开头' }, { t: '结尾（' }])).toEqual([
      { t: '，开头' },
      { t: '结尾（' },
    ])
  })

  test('接收方是待填占位时不并入，标点不沾虚线与警示色', () => {
    const runs: Run[] = [{ t: '联系', ph: true }, { t: '，谢谢（' }, { t: '占位', ph: true }]
    expect(mergeEdgePunctuation(runs)).toEqual(runs)
  })

  test('五份文档：合并前确有违规边界，合并后无片段以闭标点起首或以开标点结尾', () => {
    let violations = 0
    for (const doc of DOCS) {
      for (const runs of collectDocRuns(doc)) {
        for (const [i, r] of runs.entries()) {
          if (i > 0 && CLOSING.includes(r.t[0] ?? '')) violations++
          if (i < runs.length - 1 && OPENING.includes(r.t.at(-1) ?? '')) violations++
        }

        const merged = mergeEdgePunctuation(runs)
        const keys = new Set<string>()
        for (const [i, r] of merged.entries()) {
          if (i > 0) expect(CLOSING.includes(r.t[0] ?? ''), `片段以闭标点起首：${r.t}`).toBe(false)
          if (i < merged.length - 1) {
            expect(OPENING.includes(r.t.at(-1) ?? ''), `片段以开标点结尾：${r.t}`).toBe(false)
          }
          const key = r.k ?? r.t
          expect(keys.has(key), `React key 重复：${key}`).toBe(false)
          keys.add(key)
        }
      }
    }
    expect(violations).toBeGreaterThan(0)
  })

  test('五份文档：文字不增不减，且只有标点字符的样式允许改变（正文字的字重/等宽/占位不变）', () => {
    for (const doc of DOCS) {
      for (const runs of collectDocRuns(doc)) {
        const before = perChar(runs)
        const after = perChar(mergeEdgePunctuation(runs))
        expect(after.map(([ch]) => ch).join('')).toBe(before.map(([ch]) => ch).join(''))
        for (const [i, [ch, style]] of before.entries()) {
          if (after[i]?.[1] !== style) {
            expect(CLOSING + OPENING, `非标点字符 "${ch}" 的样式被改变`).toContain(ch)
          }
          // 待填占位的样式绝不能被改变
          expect(after[i]?.[1].endsWith('|true')).toBe(style.endsWith('|true'))
        }
      }
    }
  })
})
