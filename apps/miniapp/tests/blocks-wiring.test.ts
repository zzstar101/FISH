/**
 * 黑名单管理页的**接线层**回归（#473）。
 *
 * 仓库没有 Taro 组件渲染基建，页面级行为只能读源码文本钉住（同
 * `tests/following-wiring.test.ts` / `tests/watchers-row-conversation.test.ts`）。
 * 这里钉住几条一改就坏、坏又不报错的接线：
 *
 * 1. 页面只经 `features/blocks/api` 走契约常量，不允许在页面里硬编码 `/me/blocks`；
 * 2. 解除以服务端 `{blocked:false}` 为准才摘行（不本地翻转、不猜成功）；
 * 3. 登录门与账号清场在场（`AuthRequired` + 渲染期清场）；
 * 4. 页面已注册进 `pkg-auth` 分包、设置页「隐私」组有入口行。
 */

// route-guard: skip-file —— 本文件引用的路由字符串是**被断言的数据样本**，不是真实跳转。
import { describe, expect, test } from 'bun:test'

async function pageSource(): Promise<string> {
  return Bun.file(new URL('../src/pkg-auth/pages/blocked/index.tsx', import.meta.url)).text()
}

describe('黑名单管理页：接线', () => {
  test('取数/解除都走 blocks api 模块，页面不硬编码契约路径', async () => {
    const code = await pageSource()
    expect(code).toContain("from '@/features/blocks/api'")
    expect(code).toContain('fetchMyBlocks')
    expect(code).toContain('setBlock(row.id, false)')
    expect(code).not.toContain('/me/blocks')
  })

  test('解除成功以服务端 blocked=false 为准才摘行，失败给行内文案', async () => {
    const code = await pageSource()
    expect(code).toContain('if (!state.blocked)')
    expect(code).toContain('describeBlockFailure')
    expect(code).toContain('已解除拉黑')
  })

  test('登录门 + 账号切换渲染期清场在场', async () => {
    const code = await pageSource()
    expect(code).toContain('AuthRequired')
    expect(code).toContain('accountSeq.current += 1')
    expect(code).toContain("prev.kind === 'ready' ? prev : { kind: 'loading' }")
  })

  test('游标分页：nextCursor 驱动页脚，页脚失败不整页报错', async () => {
    const code = await pageSource()
    expect(code).toContain('ready.nextCursor !== null')
    expect(code).toContain('moreError')
  })

  test('页面注册在 pkg-auth 分包，设置页隐私组有入口行', async () => {
    const appConfig = await Bun.file(new URL('../src/app.config.ts', import.meta.url)).text()
    expect(appConfig).toContain("'pages/blocked/index'")

    const settings = await Bun.file(
      new URL('../src/pkg-auth/pages/settings/index.tsx', import.meta.url),
    ).text()
    expect(settings).toContain('/pkg-auth/pages/blocked/index')
    expect(settings).toContain('黑名单')
  })
})

describe('他人主页拉黑入口：接线', () => {
  test('走 blocks api 模块；拉黑过确认弹窗、解除直接执行；成功以服务端为准回填', async () => {
    const code = await Bun.file(
      new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url),
    ).text()

    expect(code).toContain("from '@/features/blocks/api'")
    expect(code).toContain('fetchBlockState')
    expect(code).toContain('blockConfirmModal')
    // 拉黑 = true（确认后），解除 = false（恢复性动作直接执行）
    expect(code).toContain('runBlockWrite(key, true)')
    expect(code).toContain('runBlockWrite(key, false)')
    // 服务端真值回填，不本地翻转
    expect(code).toContain('setBlockRead({ blocked: state.blocked })')
  })

  test('读状态之前不渲染、读失败保持隐藏；epoch 守卫与关注钮同一把钥匙', async () => {
    const code = await Bun.file(
      new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url),
    ).text()

    expect(code).toContain('blockEntryView({ read: blockRead, pending: blockBusy })')
    expect(code).toContain('setBlockRead(null)')
    expect(code).toContain('blockKeyRef.current !== key')
  })

  test('写失败给域内稳定文案，401 给登录文案（不裸抛）', async () => {
    const code = await Bun.file(
      new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url),
    ).text()

    expect(code).toContain('describeBlockFailure(error)')
    expect(code).toContain('登录已失效，请重新登录')
  })
})
