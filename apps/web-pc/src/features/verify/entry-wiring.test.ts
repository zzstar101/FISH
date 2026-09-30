import { describe, expect, test } from 'bun:test'

/**
 * 入口接线（#380 验收 1：未认证用户在 PC 有可发现的认证入口）。
 *
 * `/profile` 与顶栏都没有渲染测试（它们要真 router + query 才能挂起来），
 * 所以用源码文本钉住这两个入口指向 `/verify`：删掉任何一处都会红。
 * 手法同 `apps/web-pc/src/features/auth/recommendation-viewer-wiring.test.ts`。
 */
async function readSource(relative: string): Promise<string> {
  return Bun.file(new URL(relative, import.meta.url)).text()
}

describe('校园认证入口', () => {
  test('个人中心徽章与顶栏徽章都指向 /verify', async () => {
    const profilePage = await readSource('../profile/profile-page.tsx')
    expect(profilePage).toContain('to="/verify"')

    const topBar = await readSource('../shell/top-bar.tsx')
    expect(topBar).toContain('to="/verify"')
  })
})
