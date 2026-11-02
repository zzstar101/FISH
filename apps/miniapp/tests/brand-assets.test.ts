/**
 * #513：品牌图只有一组 —— `src/assets/brand/` 里只有出口 `index.ts` 与它导出的图，
 * 体积合计 ≤ 30KB；首页 / 我的 / 登录 / 关于 4 个页面都经 `BRAND` 取图。
 */
import { expect, test } from 'bun:test'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')
const DIR = join(SRC, 'assets', 'brand')

test('brand/ 只有出口与 4 张图，合计 ≤ 30KB', () => {
  const files = readdirSync(DIR).sort()
  expect(files).toEqual(['index.ts', 'lockup.png', 'mark.png', 'share.png', 'wordmark.png'])
  const bytes = files
    .filter((f) => f.endsWith('.png'))
    .reduce((n, f) => n + statSync(join(DIR, f)).size, 0)
  expect(bytes).toBeLessThanOrEqual(30 * 1024)
})

test('4 个页面都从 BRAND 出口取品牌图，没有直接 import png', async () => {
  for (const page of [
    'pages/home/index.tsx',
    'pages/profile/index.tsx',
    'pkg-auth/pages/login/index.tsx',
    'pkg-legal/pages/about/index.tsx',
  ]) {
    const code = await Bun.file(join(SRC, page)).text()
    expect({ page, ok: code.includes("from '@/assets/brand'") && code.includes('BRAND.') }).toEqual(
      { page, ok: true },
    )
  }
  const direct: string[] = []
  for await (const f of new Bun.Glob('**/*.{ts,tsx}').scan(SRC)) {
    if (f.startsWith('assets/brand/')) continue
    if (/assets\/brand\/[^'"]+\.png/.test(await Bun.file(join(SRC, f)).text())) direct.push(f)
  }
  expect(direct).toEqual([])
})
