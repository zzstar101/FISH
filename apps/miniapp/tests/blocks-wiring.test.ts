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

  test('首屏 / 加载更多的回包都先过持有者判据才落地（解除时不把刚摘掉的行塞回来）', async () => {
    const code = await pageSource()
    expect(code).toContain('nextBlocksLoad(prev, next)')
    expect(code).toContain('moreReplyLanded({ gen, genNow: loadGen.current, token, tokenNow:')
    expect(code).toContain('if (held()) setLoadingMore(false)')
  })

  /**
   * 只钉「标识符还在」是钉不住回归的：`held()` 让代次一变就恒为假，于是**换代的那条
   * 路径**必须自己收回页脚持有权，否则 `loadingMore` 再也没人熄，页脚一直停在「正在加载…」
   * （下拉刷新能救回来，但一次解除就让用户点不动页脚显然是缺陷）。
   * 所以这里钉的是**相邻性** —— 收回动作必须紧贴 `loadGen.current + 1`，不是散落在别处。
   */
  test('解除成功换代时先收回「加载更多」的持有权（否则页脚一直卡在正在加载）', async () => {
    const code = await pageSource()
    expect(code).toMatch(
      /pendingMore\.current\?\.\(\)[\s\S]{0,400}?moreToken\.current = null[\s\S]{0,200}?setLoadingMore\(false\)[\s\S]{0,200}?setMoreError\(false\)[\s\S]{0,200}?loadGen\.current \+ 1/,
    )
  })

  test('解除单飞期间：点了不执行，且其它行视觉降级（不能看起来还能点）', async () => {
    const code = await pageSource()
    // 执行侧守卫（单飞）
    expect(code).toContain('if (busyId !== null) return')
    expect(code).toContain("busyId === row.id ? ' is-busy' : busyId !== null ? ' is-off' : ''")
    const scss = await Bun.file(
      new URL('../src/pkg-auth/pages/blocked/index.scss', import.meta.url),
    ).text()
    expect(scss).toMatch(/&\.is-busy,\s*&\.is-off\s*\{\s*opacity: 0\.5;/)
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
    expect(code).toContain('setBlockRead({ key, blocked: state.blocked })')
  })

  test('读状态之前不渲染（不猜状态）；读取用 epoch 守卫，换页主/换账号即作废', async () => {
    const code = await Bun.file(
      new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url),
    ).text()

    expect(code).toContain(
      'blockEntryView({ read: blockRead, key: followKey, pending: blockBusy })',
    )
    // 读失败落回「没读到」 → 入口不渲染。断言必须**切到读 effect 那一段**再看，
    // 否则 `blockKeyRef` / `isUnauthenticatedError` 在写路径（runBlockWrite）里到处都是，
    // 正则会在别处命中，删掉读分支的守卫也照样 pass。
    const readFx = code.slice(
      code.indexOf('fetchBlockState(userId)'),
      code.indexOf('runBlockWrite'),
    )
    expect(readFx.length).toBeGreaterThan(0)
    expect(code).toContain('setBlockRead(null)')
    // `.then` 与 `.catch` 各一把 epoch 守卫：换页主/换账号后在飞回包不许落地
    expect(readFx).toContain('if (blockKeyRef.current !== key || state === null) return')
    expect(readFx).toContain(
      'if (blockKeyRef.current !== key || isUnauthenticatedError(error)) return',
    )
  })

  test('渲染与点击都先过 blockReadOf：换页主/换账号时旧归属的状态既不可显示也不可点', async () => {
    const code = await Bun.file(
      new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url),
    ).text()

    expect(code).toContain('blockReadOf(blockRead, followKey)')
    expect(code).toContain('if (blockBusy || current === null || !canFollow) return')
  })

  test('写失败给域内稳定文案，401 给登录文案（不裸抛）', async () => {
    const code = await Bun.file(
      new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url),
    ).text()

    expect(code).toContain('describeBlockFailure(error)')
    expect(code).toContain('登录已失效，请重新登录')
  })
})

describe('会话域中性提示（#466 验收：报错不暴露对方黑名单）', () => {
  test('建会话描述函数带 CONVERSATION_UNAVAILABLE 分支，且共用同一中性文案常量', async () => {
    const code = await Bun.file(new URL('../src/features/chat/api.ts', import.meta.url)).text()

    expect(code).toContain("CONVERSATION_UNAVAILABLE_TEXT = '会话当前不可用'")
    expect(code).toMatch(
      /describeCreateConversationFailure[\s\S]*?code === 'CONVERSATION_UNAVAILABLE'/,
    )
  })

  test('聊一聊 / 想要匹配入口把该码映射到中性文案，而不是「请重试」', async () => {
    const listingDetail = await Bun.file(
      new URL('../src/pkg-browse/pages/listing-detail/index.tsx', import.meta.url),
    ).text()
    expect(listingDetail).toContain('CONVERSATION_UNAVAILABLE_TEXT')

    const match = await Bun.file(
      new URL('../src/pkg-browse/pages/match/index.tsx', import.meta.url),
    ).text()
    expect(match).toContain('CONVERSATION_UNAVAILABLE_TEXT')
    expect(match).toContain("code === 'CONVERSATION_UNAVAILABLE'")
  })

  test('会话页文本发送失败遇到该码：中性 toast 直出，失败气泡保留可重试', async () => {
    const code = await Bun.file(
      new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url),
    ).text()

    expect(code).toMatch(/code === 'CONVERSATION_UNAVAILABLE'/)
    expect(code).toContain('会话当前不可用，暂时无法发送消息')
  })
})
