import { describe, expect, test } from 'bun:test'

/**
 * 首页吸顶分类条归位锁的**接线**（#320 审查 P1/P2）。
 *
 * `tests/home-category-settle.test.ts` 锁的是纯判据（落点、要不要锁），锁不住下面这些 ——
 * 它们只在 `pages/home/index.tsx` 的源码里可见，写错了不会有任何编译/运行时错误：
 *
 * 1. **`window.setTimeout` 不能用**：真机的小程序逻辑层没有浏览器 `window`，这一行会抛
 *    `ReferenceError`，分类切换在 `load()` / `pageScrollTo()` 之前就断掉。⚠️ 这条**端上
 *    演示测不出来** —— 开发者工具的模拟器自己注入了浏览器式全局（实测 `typeof window ===
 *    'object'`、`window === globalThis`、`window.setTimeout` 可用），只有真机才会炸。所以
 *    只能按源码钉住。同一处还要求**保留句柄**。
 * 2. **连点要换掉旧定时器**：A→B→C 连点时，A 的定时器会在 C 的动画没跑完时先解锁，
 *    判定在动画途中翻面（= 这层锁本要消除的抖动），所以解锁计时必须从最后一次归位算起。
 * 3. **只在真的会滚动时才上锁**：页面还没过吸顶点时落点 = 当前位置，无条件上锁会让
 *    「点完立刻下滑」的 260ms 里吸顶条出不来。
 * 4. **卸载清定时器**：迟到的回调不该写回已销毁的页面。
 *
 * 断言切到具体片段（`code()` 去掉注释后再查），不查整份文件：整份文件的子串命中挡不住
 * 「守卫挪到了 setter 之后」这类改法，而本页注释里正写着这些机制的说明。
 */

async function homeSource(): Promise<string> {
  return await Bun.file(new URL('../src/pages/home/index.tsx', import.meta.url)).text()
}

/** 去掉注释后的源码：反面断言（「不许出现 X」）必须看代码，注释里正解释着这些机制 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 取 `from` 到其后第一个 `to` 之间的源码（两端都不含） */
async function slice(from: string, to: string): Promise<string> {
  const text = await homeSource()
  const start = text.indexOf(from)
  expect(start, `缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end, `缺少片段：${to}`).toBeGreaterThan(start)
  return text.slice(start + from.length, end)
}

describe('小程序运行时：不许用 browser-only 的 window', () => {
  test('页面源码里没有 window（原生小程序没有这个全局）', async () => {
    expect(code(await homeSource())).not.toContain('window')
  })

  test('解锁定时器走全局 setTimeout，且句柄存进 ref（可取消）', async () => {
    const lock = await slice('const lockNavSettle = ', 'const releaseNavSettle')
    expect(lock).toContain('navSettleTimerRef.current = setTimeout(')
    // 回调里把句柄归零：否则已释放的句柄留在 ref 上，下一次 clear 清的是空气
    expect(lock).toContain('navSettleTimerRef.current = null')
    expect(lock).toContain('navSettleRef.current = false')
  })
})

describe('连点分类：解锁计时从最后一次归位算起', () => {
  test('上锁前先清掉上一轮的定时器', async () => {
    const lock = await slice('const lockNavSettle = ', 'const releaseNavSettle')
    // `clearTimeout` 必须出现在 `setTimeout` **之前** —— 挪到后面就等于没防住 A 的旧回调
    const cleared = lock.indexOf('clearTimeout(navSettleTimerRef.current)')
    const armed = lock.indexOf('navSettleTimerRef.current = setTimeout(')
    expect(cleared).toBeGreaterThanOrEqual(0)
    expect(armed).toBeGreaterThanOrEqual(0)
    expect(cleared).toBeLessThan(armed)
  })
})

describe('锁只跟真位移走（不然「点完立刻下滑」吸顶条出不来）', () => {
  test('onCategoryTap 用 resolveCategorySettle 的两个结果分别决定上锁与滚动', async () => {
    const handler = await slice('const onCategoryTap = ', ' * 顶栏高度')
    expect(handler).toContain('resolveCategorySettle(scrollTopRef.current, pinAt.current)')
    expect(handler).toContain('if (repositions) lockNavSettle()')
    // 不需要归位那一支必须**主动解锁**：上一轮的锁若还挂着，判定会一直钉在旧值上
    expect(handler).toContain('else releaseNavSettle()')
    // 两次 `pageScrollTo`（重复点当前分类 / 换分类）都受同一个判据管。压掉空白再数：
    // biome 会把单行 `if` 折成两行，按原样匹配会把格式当成语义
    const flat = handler.replace(/\s+/g, ' ')
    const gated = flat.match(/if \(repositions\) void Taro\.pageScrollTo\(/g) ?? []
    expect(gated.length).toBe(2)
    expect((flat.match(/void Taro\.pageScrollTo\(/g) ?? []).length).toBe(2)
    // 常量从 nav-settle 来，不在页面里另写数字
    expect(handler).toContain('CATEGORY_SCROLL_DURATION')
    expect(await homeSource()).toContain("from './nav-settle'")
  })

  test('吸顶判定按锁分流，且判定取自 navSettleRef（不是 state）', async () => {
    const scroll = await slice('usePageScroll(({ scrollTop }) => {', 'const backToTop')
    expect(scroll).toContain('navSettleRef.current ? catsPinned : scrollTop >= pinAt.current')
  })
})

describe('卸载清理', () => {
  test('useUnload 接的是同一个 release（清句柄 + 放开判定）', async () => {
    expect(await homeSource()).toContain('useUnload(releaseNavSettle)')
    // `useUnload` 得从 `@tarojs/taro` 真导入，不能只是写了个名字
    const importBlock = await slice('import Taro, {', "} from '@tarojs/taro'")
    expect(importBlock).toContain('useUnload')
  })

  test('release 同时清定时器与判定（只清一个都会留下脏状态）', async () => {
    const release = await slice('const releaseNavSettle = ', 'useUnload(')
    expect(release).toContain('clearTimeout(navSettleTimerRef.current)')
    expect(release).toContain('navSettleTimerRef.current = null')
    expect(release).toContain('navSettleRef.current = false')
  })
})
