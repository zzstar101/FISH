import { describe, expect, test } from 'bun:test'

/**
 * #703：「我的」页与他人主页的 **UID 行**接线。
 *
 * 端上展示的是人类可读 UID（10 位数字），格式严格 `UID 1234567890` —— 前缀 + 一个空格 +
 * 10 位、不分组；整行可点复制，成功 / 失败各一条 toast，两页文案同一套。这些是视觉与
 * 文案契约，typecheck / 功能单测都看不见，所以按本仓既有手法（`order-list-state.test.ts`
 * 的源码字符串断言）钉住两页的调用点：格式串、位置（昵称含认证徽章之后）、复制载荷、toast 文案。
 *
 * 端上刻意不做「按 uid 搜人」（Issue #703 明确排除），这里也不该出现任何输入 / 搜索接线。
 */
const SRC = new URL('../src/', import.meta.url)

async function source(relPath: string): Promise<string> {
  return await Bun.file(new URL(relPath, SRC)).text()
}

/** 取 `start` 起、到其后第一个 `end` 为止的片段；找不到给空串（调用方断言非空即转红） */
function slice(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  if (from < 0) return ''
  const to = text.indexOf(end, from + start.length)
  return to < 0 ? '' : text.slice(from, to + end.length)
}

describe('「我的」页：昵称 / 认证徽章之后一行 UID', () => {
  test('格式严格 `UID <10 位>`，整行可点复制且有可点击语义', async () => {
    const code = await source('pages/profile/index.tsx')
    const row = slice(code, 'className="profile__uid"', '</View>')
    expect(row).not.toBe('')
    // 前缀 + 一个空格 + 原始 uid（不分组、不截断）
    expect(row).toContain('profile__uid-txt">UID {user.uid}</Text>')
    expect(row).toContain('aria-role="button"')
    // aria-label 的可点语义：`UID <uid>` + 「点击复制」（模板占位拆开断言，免得字符串里出现 `${`）
    expect(row).toContain('aria-label={`UID ')
    expect(row).toContain('，点击复制`}')
    expect(row).toContain('onClick={() => void copyUid(user.uid)}')
  })

  test('位置在昵称行（含认证徽章）之后、签名行之前', async () => {
    const code = await source('pages/profile/index.tsx')
    const nameRow = code.indexOf('className="profile__name-row"')
    const uid = code.indexOf('className="profile__uid"')
    const signature = code.indexOf('className="profile__sig"')
    expect(nameRow).toBeGreaterThan(-1)
    expect(uid).toBeGreaterThan(nameRow)
    expect(signature).toBeGreaterThan(uid)
  })

  test('复制载荷是裸 uid；成功 / 失败各一条 toast', async () => {
    const code = await source('pages/profile/index.tsx')
    const handler = slice(code, 'const copyUid = async', '\n  }')
    expect(handler).not.toBe('')
    expect(handler).toContain('Taro.setClipboardData({ data: uid })')
    expect(handler).toContain("toast('UID 已复制')")
    expect(handler).toContain("toast('复制失败')")
  })
})

describe('他人主页：昵称行之后一行 UID', () => {
  test('格式严格 `UID <10 位>`，整行可点复制且有可点击语义', async () => {
    const code = await source('pkg-browse/pages/user/index.tsx')
    const row = slice(code, 'className="uhome__uid"', '</View>')
    expect(row).not.toBe('')
    expect(row).toContain('uhome__uid-tx">UID {profile.uid}</Text>')
    expect(row).toContain('aria-role="button"')
    expect(row).toContain('aria-label={`UID ')
    expect(row).toContain('，点击复制`}')
    expect(row).toContain('onClick={() => void copyUid(profile.uid)}')
  })

  test('位置在昵称行之后、在线态之前（与「我的」页同一层级）', async () => {
    const code = await source('pkg-browse/pages/user/index.tsx')
    const nameRow = code.indexOf('className="uhome__nameRow"')
    const uid = code.indexOf('className="uhome__uid"')
    const presence = code.indexOf('<PresenceBadge')
    expect(nameRow).toBeGreaterThan(-1)
    expect(uid).toBeGreaterThan(nameRow)
    expect(presence).toBeGreaterThan(uid)
  })

  test('复制载荷是裸 uid；成功 / 失败各一条 toast（文案与「我的」页同一套）', async () => {
    const code = await source('pkg-browse/pages/user/index.tsx')
    const handler = slice(code, 'const copyUid = async', '\n  }')
    expect(handler).not.toBe('')
    expect(handler).toContain('Taro.setClipboardData({ data: uid })')
    expect(handler).toContain("title: 'UID 已复制'")
    expect(handler).toContain("title: '复制失败'")
  })
})
