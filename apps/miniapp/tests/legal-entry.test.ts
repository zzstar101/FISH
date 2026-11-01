import { describe, expect, test } from 'bun:test'
import { COMMUNITY_GUIDELINES_DOC } from '../src/features/legal/community-guidelines'
import {
  applyConsent,
  crossLinkUrl,
  isEntryFromAuth,
  LEGAL_PAGES,
  markConsent,
  takeConsent,
} from '../src/features/legal/entry'
import { INFO_COLLECTION_DOC } from '../src/features/legal/info-collection'
import { PRIVACY_DOC } from '../src/features/legal/privacy'
import { TERMS_DOC } from '../src/features/legal/terms'
import { THIRD_PARTY_SHARING_DOC } from '../src/features/legal/third-party-sharing'
import type { Block, LegalDoc, Run } from '../src/features/legal/types'

/**
 * 法务页入口来源与同意决定的回传。
 *
 * 这两个判定的后果都在**端上可见**：前者决定吸底同意条出不出现（从设置页进来是纯阅读，
 * 不该再点一次「同意」），后者决定用户按过同意条之后回到登录页，协议勾选是不是真的跟着变。
 */

describe('isEntryFromAuth —— 只有登录/注册流程进入才显示吸底同意条', () => {
  test('from=login / from=register 为真', () => {
    expect(isEntryFromAuth({ from: 'login' })).toBe(true)
    expect(isEntryFromAuth({ from: 'register' })).toBe(true)
  })

  test('无参数（设置页 / 关于页 / 页脚互链进来）与其它来源为假', () => {
    expect(isEntryFromAuth({})).toBe(false)
    expect(isEntryFromAuth({ from: undefined })).toBe(false)
    expect(isEntryFromAuth({ from: 'settings' })).toBe(false)
    expect(isEntryFromAuth({ from: '' })).toBe(false)
  })
})

describe('takeConsent —— 同意条决定的跨页一次性信号', () => {
  test('取走即清：第二次取不到，不会反复改动用户的勾选', () => {
    expect(takeConsent()).toBeNull()
    markConsent('declined')
    expect(takeConsent()).toBe('declined')
    expect(takeConsent()).toBeNull()
  })

  test('两个方向都回传：agreed 与 declined 各自取回原值', () => {
    markConsent('agreed')
    expect(takeConsent()).toBe('agreed')
    markConsent('declined')
    expect(takeConsent()).toBe('declined')
  })

  test('后写的决定覆盖前一个，不会同时挂着两个', () => {
    markConsent('agreed')
    markConsent('declined')
    expect(takeConsent()).toBe('declined')
    expect(takeConsent()).toBeNull()
  })
})

describe('applyConsent —— 决定怎么落到登录页的勾选态上', () => {
  test('agreed 一律勾上、declined 一律取消 —— 两个方向都覆盖', () => {
    // 「同意并继续」在用户先取消过勾选时也必须把勾选补回来，否则回到登录页 CTA 仍是禁用的
    expect(applyConsent('agreed', false)).toBe(true)
    expect(applyConsent('agreed', true)).toBe(true)
    expect(applyConsent('declined', true)).toBe(false)
    expect(applyConsent('declined', false)).toBe(false)
  })

  test('没有待处理的决定时保持原值，不擅自改动用户的勾选', () => {
    expect(applyConsent(null, true)).toBe(true)
    expect(applyConsent(null, false)).toBe(false)
  })
})

describe('crossLinkUrl —— 五份法务文档互跳保留登录来源，跳意见反馈不带', () => {
  test('从登录进入（entry=true）时，五份法务页互跳均延续 ?from=login', () => {
    expect(LEGAL_PAGES.size).toBe(5)
    for (const page of LEGAL_PAGES) {
      expect(crossLinkUrl(page, true)).toBe(`${page}?from=login`)
      expect(crossLinkUrl(page, false)).toBe(page)
    }
  })

  test('跳往意见反馈等非法务页时，无论 entry 为何都不追加 ?from=login', () => {
    expect(crossLinkUrl('/pkg-legal/pages/feedback/index', true)).toBe(
      '/pkg-legal/pages/feedback/index',
    )
  })
})

function collectDocRuns(doc: LegalDoc): { where: string; runs: Run[] }[] {
  const out: { where: string; runs: Run[] }[] = []
  for (const [i, runs] of doc.meta.entries()) out.push({ where: `meta[${i}]`, runs })
  if (doc.brief) {
    out.push({ where: 'brief.lead', runs: doc.brief.lead })
    for (const [i, runs] of doc.brief.items.entries()) {
      out.push({ where: `brief.items[${i}]`, runs })
    }
  }
  if (doc.callout) out.push({ where: 'callout.runs', runs: doc.callout.runs })
  for (const [i, runs] of doc.footNote.entries()) out.push({ where: `footNote[${i}]`, runs })
  for (const sec of doc.sections) {
    for (const block of sec.blocks) {
      collectBlockRuns(block, `${sec.id}/${block.key}`, out)
    }
  }
  return out
}

function collectBlockRuns(
  block: Block,
  prefix: string,
  out: { where: string; runs: Run[] }[],
): void {
  if (block.kind === 'list') {
    for (const item of block.items) {
      out.push({ where: `${prefix}/${item.key}.name`, runs: item.name })
      out.push({ where: `${prefix}/${item.key}.use`, runs: item.use })
    }
    return
  }
  out.push({ where: prefix, runs: block.runs })
}

describe('五份法务文档数据模型不变量（v2.0）', () => {
  const DOCS: [string, LegalDoc][] = [
    ['terms', TERMS_DOC],
    ['privacy', PRIVACY_DOC],
    ['info-collection', INFO_COLLECTION_DOC],
    ['third-party-sharing', THIRD_PARTY_SHARING_DOC],
    ['community-guidelines', COMMUNITY_GUIDELINES_DOC],
  ]

  test('全部升级至 v2.0（2026-11-01），不含 ph 占位或「待填」字样，React key 无冲突', () => {
    for (const [name, doc] of DOCS) {
      const metaText = doc.meta.map((line) => line.map((r) => r.t).join('')).join(' | ')
      expect(metaText).toContain('v2.0')
      expect(metaText).toContain('2026-11-01')

      const secIds = new Set<string>()
      const blockKeys = new Set<string>()
      const itemKeys = new Set<string>()
      for (const sec of doc.sections) {
        expect(secIds.has(sec.id)).toBe(false)
        secIds.add(sec.id)
        for (const block of sec.blocks) {
          expect(blockKeys.has(block.key)).toBe(false)
          blockKeys.add(block.key)
          if (block.kind === 'list') {
            for (const item of block.items) {
              expect(itemKeys.has(item.key)).toBe(false)
              itemKeys.add(item.key)
            }
          }
        }
      }

      for (const { where, runs } of collectDocRuns(doc)) {
        const runKeys = new Set<string>()
        for (const r of runs) {
          expect(r.ph, `${name}:${where} 仍含 ph 占位`).toBeUndefined()
          expect(r.t.includes('待填'), `${name}:${where} 仍含「待填」文本`).toBe(false)
          const rk = r.k ?? r.t
          expect(runKeys.has(rk), `${name}:${where} 存在重复 Run key "${rk}"`).toBe(false)
          runKeys.add(rk)
        }
      }

      const linkPages = new Set<string>()
      for (const link of doc.links) {
        expect(linkPages.has(link.page)).toBe(false)
        linkPages.add(link.page)
      }
    }
  })
})
