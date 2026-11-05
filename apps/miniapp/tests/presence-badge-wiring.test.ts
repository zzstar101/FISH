/**
 * 在线态徽标的**接线**回归（#625 审查）。
 *
 * `PresenceBadge` 把「外壳 / dot / 文案」三处类名从「两处写死」收敛成「一处按规律派生」
 * （`${className}` / `${className}-dot` / `${className}-tx`）。规律本身只有注释在守护，
 * 所以这里钉住两件事：
 *
 * 1. 两个展示位传进来的外壳类名必须还是 `detail__presence` / `uhome__presence` ——
 *    样式表里写的就是 `detail__presence-dot`、`uhome__presence-tx` 这一族；
 * 2. 两个页面都必须调 `usePresenceClock()` —— 时钟是页面驱动起停的，页面忘了占上，
 *    绿点会停在一个冻结的「现在」上，且不报错（隐式契约，只能靠测试钉）。
 */
import { describe, expect, test } from 'bun:test'

async function source(path: string): Promise<string> {
  return Bun.file(new URL(`../src/pkg-browse/pages/${path}/index.tsx`, import.meta.url)).text()
}

/** 页面必须传这个外壳类名（样式表按 `${外壳}-dot` / `${外壳}-tx` 写） */
const CASES = [
  { page: 'listing-detail', className: 'detail__presence', presence: 'data.seller.presence' },
  { page: 'user', className: 'uhome__presence', presence: 'profile.presence' },
]

describe('在线态徽标：两个展示位的接线', () => {
  for (const item of CASES) {
    test(`${item.page}：外壳类名仍是 ${item.className}`, async () => {
      const code = await source(item.page)
      expect(code).toContain(
        `<PresenceBadge presence={${item.presence}} className="${item.className}" />`,
      )
    })

    test(`${item.page}：页面自己占上时钟（否则徽标停在一个冻结的「现在」上）`, async () => {
      const code = await source(item.page)
      expect(code).toContain('import { usePresenceClock }')
      // 调用点必须存在，且不是 import 那行
      expect(code.replace(/^import .*$/gm, '')).toContain('usePresenceClock()')
    })
  }

  test('样式表里两个展示位都按「外壳 / -dot / -tx」写', async () => {
    for (const [page, className] of [
      ['listing-detail', 'detail__presence'],
      ['user', 'uhome__presence'],
    ] as const) {
      const scss = await Bun.file(
        new URL(`../src/pkg-browse/pages/${page}/index.scss`, import.meta.url),
      ).text()
      for (const selector of [className, `${className}-dot`, `${className}-tx`]) {
        expect(scss).toContain(`.${selector}`)
      }
      expect(scss).toContain(`.${className}.is-online`)
    }
  })
})
