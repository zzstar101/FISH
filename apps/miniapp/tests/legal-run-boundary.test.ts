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

const CLOSING_AT_START = /^[。，、；：？！）」』》】〕”’%]/
const OPENING_AT_END = /[（「『《【〔“‘]$/

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

  test('独占片段的句号并回前一片段并被丢弃，不改变加粗', () => {
    const merged = mergeEdgePunctuation([
      { t: '你可随时注销' },
      { t: '自助申请注销', b: true },
      { t: '。' },
    ])
    expect(merged).toEqual([{ t: '你可随时注销' }, { t: '自助申请注销。', b: true }])
  })

  test('没有邻居可并入时原样保留', () => {
    expect(mergeEdgePunctuation([{ t: '，开头' }, { t: '结尾（' }])).toEqual([
      { t: '，开头' },
      { t: '结尾（' },
    ])
  })

  test('五份文档合并后无片段以闭标点起首或以开标点结尾，且文字不增不减', () => {
    const docs = [
      TERMS_DOC,
      PRIVACY_DOC,
      INFO_COLLECTION_DOC,
      THIRD_PARTY_SHARING_DOC,
      COMMUNITY_GUIDELINES_DOC,
    ]
    for (const doc of docs) {
      for (const runs of collectDocRuns(doc)) {
        const merged = mergeEdgePunctuation(runs)
        expect(merged.map((r) => r.t).join('')).toBe(runs.map((r) => r.t).join(''))
        const keys = new Set<string>()
        for (const [i, r] of merged.entries()) {
          if (i > 0) expect(r.t, `片段以闭标点起首：${r.t}`).not.toMatch(CLOSING_AT_START)
          if (i < merged.length - 1)
            expect(r.t, `片段以开标点结尾：${r.t}`).not.toMatch(OPENING_AT_END)
          const key = r.k ?? r.t
          expect(keys.has(key), `React key 重复：${key}`).toBe(false)
          keys.add(key)
        }
      }
    }
  })
})
