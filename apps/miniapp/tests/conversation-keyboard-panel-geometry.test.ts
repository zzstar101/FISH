import { describe, expect, test } from 'bun:test'
import {
  BOTTOM_SLACK_PX,
  growBottomAllowance,
  isNearBottom,
  mergeViewportShrink,
  nextKeyboardInset,
  PANEL_CONTENT_RPX,
  PANEL_DISC_RPX,
  PANEL_LABEL_RPX,
  PANEL_PADDING_RPX,
  PANEL_TILE_GAP_RPX,
  planScrollFix,
  resolveBottomInset,
  resolvePanelHeightPx,
  resolveSentinel,
  shouldHandOffToKeyboard,
  stickAfterScroll,
} from '../src/pkg-social/pages/conversation/view'

/**
 * 会话页输入栏 / 消息流的几何（#560、#561）。
 *
 * 两票是同一套时序：输入栏是 100vh 弹性列的最后一个流内块、消息流是它上面那条 `flex: 1`
 * 的 ScrollView，所以**任何**让输入栏变高/变矮的动作（键盘升降、面板开合、语音态切换）
 * 都会同时改变消息流的可视高度。改前它们分几帧落地：先长高再长高一次 → 输入栏「先上提
 * 再回落」；消息流连着变矮 → 原生层把越界的滚动偏移截断/归零后无人重指尾行 → 「跳回顶部
 * 再错位抽搐」。
 *
 * 本仓 `tests/` 没有 Taro 组件渲染基建，页面接线只能读源码钉住（先例
 * `tests/back-top-scroll-source.test.ts`）：断言**切到具体片段**再查，整份文件的子串命中
 * 挡不住「属性挂到了别的 Textarea / 判据被删回去」这类改法。
 */

const pageUrl = new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url)
const styleUrl = new URL('../src/pkg-social/pages/conversation/index.scss', import.meta.url)

async function pageSource(): Promise<string> {
  return await Bun.file(pageUrl).text()
}

async function styleSource(): Promise<string> {
  return await Bun.file(styleUrl).text()
}

/** 去掉注释再空白归一：注释里出现的标识符不算实现（先例 back-top-scroll-source.test.ts）。 */
function squash(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
}

/** 切出一个标签：从 `needle` 起到它自己的 `>`（跳过 `=>` 里的 `>`）。 */
function tag(source: string, needle: string): string {
  const start = source.indexOf(needle)
  if (start < 0) throw new Error(`找不到片段：${needle}`)
  let end = source.indexOf('>', start)
  while (end > 0 && source[end - 1] === '=') end = source.indexOf('>', end + 1)
  return source.slice(start, end + 1)
}

/** 切出一个函数体：从 `from` 起到 `to`（`to` 不在其前时抛错）。 */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  if (start < 0) throw new Error(`找不到片段：${from}`)
  const end = source.indexOf(to, start)
  if (end < 0) throw new Error(`找不到结尾：${to}`)
  return source.slice(start, end)
}

describe('贴底判据（#561）', () => {
  test('底部差在容差内算贴底，差得远算没贴底', () => {
    // 底部完全对齐
    expect(isNearBottom({ scrollTop: 400, scrollHeight: 1000, viewportHeight: 600 })).toBe(true)
    // 差一点点（输入框长高几 px / iOS 取整）：仍算贴底
    expect(
      isNearBottom({ scrollTop: 400 - BOTTOM_SLACK_PX, scrollHeight: 1000, viewportHeight: 600 }),
    ).toBe(true)
    // 往上翻了一大段：不算贴底，几何变化时不许把人拽回底部
    expect(
      isNearBottom({
        scrollTop: 400 - BOTTOM_SLACK_PX - 1,
        scrollHeight: 1000,
        viewportHeight: 600,
      }),
    ).toBe(false)
  })

  test('内容不足一屏时恒贴底', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, viewportHeight: 600 })).toBe(true)
  })

  test('视口还没量到按贴底处理：宁可多滚一次到底，也不把偏移丢掉', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 2000, viewportHeight: 0 })).toBe(true)
  })

  test('本页自己造成的视口缩量按 slack 临时放宽：多行输入后仍算贴底', () => {
    // 输入框从 1 行长到 4 行，视口矮 54pt：滚动事件可能还是「旧 scrollTop + 新 scrollHeight」
    const shrunk = { scrollTop: 400 - 54, scrollHeight: 1000, viewportHeight: 600 }
    // 只有常驻基线（24）时会被判成「翻历史」—— 正是 #560 说的「多行输入后再切更明显」
    expect(isNearBottom(shrunk)).toBe(false)
    // 把本次缩量算进容差后仍算贴底，重锚不会被守卫挡掉
    expect(isNearBottom(shrunk, 54)).toBe(true)
    // 真往上翻了一大段时，再大的 slack 也不能算贴底（否则会把翻历史的人拽回底部）
    expect(isNearBottom({ ...shrunk, scrollTop: 0 }, 54)).toBe(false)
  })
})

describe('贴底标志与偏移回读的判据（#561，纯函数表驱动）', () => {
  test('onScroll 之后贴底标志恒等于「此刻贴底」，不取反', () => {
    // 取反的后果：贴底的人再也回不到底部、翻历史的人被拽回底部，端上只表现为「有时候跳一下」
    expect(stickAfterScroll(true)).toBe(true)
    expect(stickAfterScroll(false)).toBe(false)
  })

  test('偏移没丢 / 丢的那次是正常截断 → 什么都不做', () => {
    // 回读时仍在底部附近：没丢
    expect(planScrollFix({ prevTop: 800, top: 790, stick: true })).toEqual({ kind: 'none' })
    expect(planScrollFix({ prevTop: 800, top: 790, stick: false })).toEqual({ kind: 'none' })
    // 内容不足一屏 / 刚打开就贴底：顶部本来就没有可滚的
    expect(planScrollFix({ prevTop: 0, top: 0, stick: true })).toEqual({ kind: 'anchor' })
    expect(planScrollFix({ prevTop: 0, top: 0, stick: false })).toEqual({ kind: 'none' })
  })

  test('偏移掉回顶部：贴底重指尾行，翻历史把原值写回去', () => {
    // 复现里的形态：几何突变后偏移掉成 0
    expect(planScrollFix({ prevTop: 800, top: 0, stick: true })).toEqual({ kind: 'anchor' })
    // 「写回哪个值」由纯函数给：写成观测值就是一次空操作
    expect(planScrollFix({ prevTop: 800, top: 0, stick: false })).toEqual({
      kind: 'restore',
      top: 800,
    })
  })

  test('边界就钉在容差上：`top` 恰等于容差算丢，多一 px 算没丢', () => {
    // `top > BOTTOM_SLACK_PX` 改成 `>=` 会让「恰好掉到容差上」被放过
    expect(planScrollFix({ prevTop: 800, top: BOTTOM_SLACK_PX, stick: false })).toEqual({
      kind: 'restore',
      top: 800,
    })
    expect(planScrollFix({ prevTop: 800, top: BOTTOM_SLACK_PX, stick: true })).toEqual({
      kind: 'anchor',
    })
    expect(planScrollFix({ prevTop: 800, top: BOTTOM_SLACK_PX + 1, stick: true })).toEqual({
      kind: 'none',
    })
    // `prevTop > BOTTOM_SLACK_PX` 改成 `>=` 会把「从没滚过」当成真实位置
    expect(planScrollFix({ prevTop: BOTTOM_SLACK_PX, top: 0, stick: false })).toEqual({
      kind: 'none',
    })
    expect(planScrollFix({ prevTop: BOTTOM_SLACK_PX + 1, top: 0, stick: false })).toEqual({
      kind: 'restore',
      top: BOTTOM_SLACK_PX + 1,
    })
  })

  test('量不到位置（`NaN`）不动，也不许拿它去翻锚点', () => {
    // `typeof NaN === 'number'`：只判类型挡不住，`NaN > 24` 又会静默变成 false
    expect(planScrollFix({ prevTop: 800, top: Number.NaN, stick: true })).toEqual({ kind: 'none' })
    expect(planScrollFix({ prevTop: Number.NaN, top: 0, stick: false })).toEqual({ kind: 'none' })
  })
})

describe('贴底容差的记账口径（#560/#561，纯函数表驱动）', () => {
  test('输入行长高：累计相加，不是只留最后一次增量', () => {
    // 1 行 → 2 行：让出 30
    expect(growBottomAllowance({ allowance: 0, prevInputPx: 34, nextInputPx: 64 })).toBe(30)
    // 2 行 → 3 行：原生那次截断滚动反映的是相对单行基线的累计 60，只留 30 就不够
    expect(growBottomAllowance({ allowance: 30, prevInputPx: 64, nextInputPx: 94 })).toBe(60)
  })

  test('输入行缩回去（删行 / autoHeight 回落）时余量要收，不是只增不减', () => {
    // 只增不减的后果：余量长期停在高水位，用户上翻不到那么多仍被判成贴底，
    // 随后的重锚把他从历史里拽回底部（#561 验收第一条）
    expect(growBottomAllowance({ allowance: 60, prevInputPx: 94, nextInputPx: 64 })).toBe(30)
    // 收到 0 为止，不留负数
    expect(growBottomAllowance({ allowance: 10, prevInputPx: 94, nextInputPx: 34 })).toBe(0)
    // 高度没变时不动
    expect(growBottomAllowance({ allowance: 30, prevInputPx: 64, nextInputPx: 64 })).toBe(30)
  })

  test('输入行基线不明（还没量到 / 刚清空）时不记增量', () => {
    // 此时 `nextInputPx` 是单行基线，不是让出的高度（记下来就等于把判据一次放到最松）
    expect(growBottomAllowance({ allowance: 0, prevInputPx: 0, nextInputPx: 94 })).toBe(0)
    expect(growBottomAllowance({ allowance: 30, prevInputPx: 0, nextInputPx: 94 })).toBe(30)
    // 回调报 0 / 负数（键盘收起时有的机型会报一次）也不记
    expect(growBottomAllowance({ allowance: 30, prevInputPx: 64, nextInputPx: 0 })).toBe(30)
  })

  test('视口缩量并进余量：取大不覆盖，且只认「缩」', () => {
    // 量测报的缩量比已有余量大 → 用大的
    expect(mergeViewportShrink({ allowance: 0, prevViewport: 600, nextViewport: 546 })).toBe(54)
    // 比已有余量小（布局没落定的一帧）→ **不许**把 `onLineChange` 刚记的增量清零
    expect(mergeViewportShrink({ allowance: 30, prevViewport: 600, nextViewport: 594 })).toBe(30)
    // 视口变高不是「让出高度」：取绝对值就会把键盘收起当成放宽
    expect(mergeViewportShrink({ allowance: 0, prevViewport: 570, nextViewport: 600 })).toBe(0)
    expect(mergeViewportShrink({ allowance: 12, prevViewport: 570, nextViewport: 600 })).toBe(12)
  })

  test('首次量测没有可比对象，不许一次性放宽到整屏', () => {
    // `prevViewport` 还是 0：差值就是整个视口高
    expect(mergeViewportShrink({ allowance: 0, prevViewport: 0, nextViewport: 600 })).toBe(0)
    expect(mergeViewportShrink({ allowance: 8, prevViewport: 0, nextViewport: 600 })).toBe(8)
    // 量到的高度无效时同理
    expect(mergeViewportShrink({ allowance: 8, prevViewport: 600, nextViewport: 0 })).toBe(8)
  })

  test('面板开合那一次缩量不记进余量（#597：主动切换不是「内容长高」）', () => {
    /**
     * 面板占掉一整块底部（内容高 + 安全区）：记进余量就等于把「贴底」一次放宽到面板那么高。
     * 翻历史的人下一次开面板时，可视高度骤降一两百 px，判定会把「他离底还很远」误读成
     * 「贴底」→ 重锚把他从历史里拽到最新一条（#597 现象三）。
     */
    expect(
      mergeViewportShrink({
        allowance: 0,
        prevViewport: 600,
        nextViewport: 600 - resolvePanelHeightPx({ windowWidth: 375, safeAreaBottom: 34 }),
        panelTransition: true,
      }),
    ).toBe(0)
    // 也不会把 `onLineChange` 刚记下的多行增量一起清掉之外的任何放宽带进来
    expect(
      mergeViewportShrink({
        allowance: 30,
        prevViewport: 600,
        nextViewport: 300,
        panelTransition: true,
      }),
    ).toBe(0)
    // 面板不开合时口径不变（同一组入参不带标志，缩量照记）
    expect(mergeViewportShrink({ allowance: 0, prevViewport: 600, nextViewport: 546 })).toBe(54)
  })
})

describe('底部底座的高度真源（#597，纯函数表驱动）', () => {
  /** 面板在 375 宽（designWidth 的一半）、34pt 安全区的 iPhone 上占多高：194rpx → 97px，再加 34 */
  const panelOn375 = resolvePanelHeightPx({ windowWidth: 375, safeAreaBottom: 34 })

  test('键盘态取键盘高度，键盘收起就是不占', () => {
    expect(
      resolveBottomInset({ panelOpen: false, keyboardHeight: 280, panelHeight: panelOn375 }),
    ).toBe(280)
    expect(
      resolveBottomInset({ panelOpen: false, keyboardHeight: 0, panelHeight: panelOn375 }),
    ).toBe(0)
    // 负值（有的机型收起时报一次）当 0，别给它一个负内边距
    expect(resolveBottomInset({ panelOpen: false, keyboardHeight: -12, panelHeight: 0 })).toBe(0)
  })

  test('面板态取「面板自己的内容高」，与此刻的键盘高度无关', () => {
    /**
     * 开面板那一刻键盘正在单调收起（280 → 196 → 0）。面板高度必须**一次**到位：
     * 跟着 `keyboardHeight` 走就会让底座连跳三档，正是 #597 现象一（整页移动 / 消息流抽搐）。
     *
     * 面板高度也**不再**取「上次/最高键盘高」（#597 追加任务）：三格图标撑成一把键盘高
     * 只会在下面留一片空白。大屏外接键盘（430 那种）同样不许把面板抬起来。
     */
    for (const keyboardHeight of [280, 196, 0, 430]) {
      expect(resolveBottomInset({ panelOpen: true, keyboardHeight, panelHeight: panelOn375 })).toBe(
        panelOn375,
      )
    }
  })

  test('面板高度只由内容与安全区决定（rpx → px 换算 + 安全区叠加）', () => {
    // 750 宽 = designWidth：scss 里的 1px 就是 1rpx，换算比 1
    expect(resolvePanelHeightPx({ windowWidth: 750, safeAreaBottom: 0 })).toBe(PANEL_CONTENT_RPX)
    // 375 宽（常见 iPhone）：194rpx → 97px
    expect(resolvePanelHeightPx({ windowWidth: 375, safeAreaBottom: 0 })).toBe(
      Math.round(PANEL_CONTENT_RPX / 2),
    )
    // 414 宽（Plus / Max）：四舍五入到整数，不吐小数
    expect(resolvePanelHeightPx({ windowWidth: 414, safeAreaBottom: 0 })).toBe(
      Math.round((PANEL_CONTENT_RPX * 414) / 750),
    )
    // 安全区原样叠在内容高之上（面板自己的 padding-bottom 里也带 env，两边必须对齐）
    expect(resolvePanelHeightPx({ windowWidth: 375, safeAreaBottom: 34 })).toBe(
      Math.round(PANEL_CONTENT_RPX / 2) + 34,
    )
    // 负的安全区当 0
    expect(resolvePanelHeightPx({ windowWidth: 375, safeAreaBottom: -10 })).toBe(
      Math.round(PANEL_CONTENT_RPX / 2),
    )
    // 量不到窗口宽度（老基础库）按 375 估：不许退化成 0，也不能是整屏
    const fallback = resolvePanelHeightPx({ windowWidth: 0, safeAreaBottom: 0 })
    expect(fallback).toBeGreaterThan(60)
    expect(fallback).toBeLessThan(140)
    // 面板整体得落在「三个 104rpx 圆钮放得下、又不至于顶掉半屏消息」的量级里
    expect(panelOn375).toBeGreaterThan(100)
    expect(panelOn375).toBeLessThan(200)
  })

  test('面板高的四个分项与 index.scss 的真源逐项一致（改 scss 不改常量必红）', async () => {
    /**
     * 面板的**实际**高度由 scss 决定（内容撑开，`height: auto`），而底座让位带的高度由
     * `view.ts` 的常量算 —— 两边必须逐项对齐，否则面板要么盖住输入行、要么在下面留一条缝。
     * 这条用例就是那把锁：改 scss 的内边距 / 圆钮尺寸 / 间隙 / 字号而不改常量，这里必红。
     */
    const css = await styleSource()
    const panel = slice(css, '.conv__panel {', '}')
    const disc = slice(css, '.conv__ptile-disc {', '}')
    const tile = slice(css, '.conv__ptile {', '}')
    const label = slice(css, '.conv__ptile-label {', '}')
    // 上下内边距各一半（scss 的 24px + 24px）
    expect(panel).toContain(`padding: ${PANEL_PADDING_RPX / 2}px 28px`)
    expect(disc).toContain(`width: ${PANEL_DISC_RPX}px`)
    expect(disc).toContain(`height: ${PANEL_DISC_RPX}px`)
    expect(tile).toContain(`gap: ${PANEL_TILE_GAP_RPX}px`)
    expect(label).toContain('font-size: 22px')
    // 文字那一行按 1.2~1.6 倍字号估；超出这个区间说明估算离实际太远，该改成读实测
    expect(PANEL_LABEL_RPX).toBeGreaterThanOrEqual(22 * 1.2)
    expect(PANEL_LABEL_RPX).toBeLessThanOrEqual(22 * 1.6)
    // 总和必须等于四项之和（防止有人只改一项却忘了总和是派生的）
    expect(PANEL_CONTENT_RPX).toBe(
      PANEL_PADDING_RPX + PANEL_DISC_RPX + PANEL_TILE_GAP_RPX + PANEL_LABEL_RPX,
    )
    // 面板内容必须比它得到的让位带矮一截（`.conv__bar` 的 `$bar-gap-px` 那条缝）
    expect(panelOn375 - Math.round(PANEL_CONTENT_RPX / 2)).toBe(34)
  })

  test('面板态 → 聚焦输入框 → 键盘首帧：中间不许塌成 0，交接只变一次（#597 F1）', () => {
    /**
     * 反方向（面板 → 键盘）的交接序列。焦点落在输入框时键盘还没起来，这一刻若就
     * `setPanelOpen(false)`，`resolveBottomInset` 只能拿到 `keyboardHeight === 0`（开面板
     * 走过 `collapseKeyboard()`）→ 底座直落 0、视口放大一整把键盘，下一拍平台报高度再长回来：
     * 「输入栏先掉到屏幕底、下方空一片、再被顶上去」，正是现象一的镜像。
     * 所以收起时刻必须推迟到键盘真落地第一帧 —— 页面就是这么接的（见下一条源码断言）。
     *
     * 面板不再与键盘等高（#597 追加任务），第 ③ 帧底座会**一次**从面板高换成键盘高，
     * 差值 = 键盘高 − 面板高。这是预期行为：只变一次，且任何一档都不是 0。
     */
    const steps = [
      // ① 面板展开：占住面板内容那一条
      { label: '① 面板态', panelOpen: true, keyboardHeight: 0 },
      // ② 聚焦当拍（键盘仍未落地）：仍然是面板态，高度不许动
      { label: '② 聚焦当拍', panelOpen: true, keyboardHeight: 0 },
      // ③ 键盘首帧到达：同一帧里收面板、落地键盘高度 —— 交接一次到位
      { label: '③ 键盘首帧', panelOpen: false, keyboardHeight: 280 },
    ]
    const heights = steps.map((step) =>
      resolveBottomInset({
        panelOpen: step.panelOpen,
        keyboardHeight: step.keyboardHeight,
        panelHeight: panelOn375,
      }),
    )
    expect(heights).toEqual([panelOn375, panelOn375, 280])
    // 序列里任何一档都不许是 0（0 = 视口凭空放大一整把键盘，就是「当拍塌空」那一档）
    expect(heights.every((height) => height > 0)).toBe(true)
    // 反面：这就是「当拍关」会塌成的那一档，钉住禁令
    expect(
      resolveBottomInset({ panelOpen: false, keyboardHeight: 0, panelHeight: panelOn375 }),
    ).toBe(0)
  })
})

describe('交接判据：这一帧键盘上报算不算「新占用者到了」（#597，纯函数表驱动）', () => {
  /**
   * 光有「面板 → 键盘推迟到键盘帧」还不够（P1 复审阻断）：收键盘动画的每一帧高度都 `> 0`，
   * 而点「+」当拍就走过 `collapseKeyboard()`，平台紧接着把收键盘拆成若干递减帧。判据里少了
   * `!closing`，键盘**开着**点「+」会在第一帧（250 那类中间值）被当成「新键盘到了」，面板
   * 约 40ms 就自己消失、底座一路连降 —— 现象一原样复发，比改前更糟。
   *
   * 这张表是纯函数层面的直接钉桩：喂的是 `nextKeyboardInset` 真实产出的三元组，页面里只
   * 调用这一个判据。**回滚页面那行条件改动，本组必须变红**（`closing: true` 那几行）。
   */
  const cases: {
    label: string
    panelOpen: boolean
    closing: boolean
    inset: number
    handOff: boolean
  }[] = [
    {
      label: '面板态 + 键盘首帧真落地',
      panelOpen: true,
      closing: false,
      inset: 280,
      handOff: true,
    },
    {
      label: '面板态 + 更矮的键盘真落地',
      panelOpen: true,
      closing: false,
      inset: 196,
      handOff: true,
    },
    { label: '面板态 + 还没落地', panelOpen: true, closing: false, inset: 0, handOff: false },
    // ↓ 这一组就是 P1：键盘开着点「+」后，平台报来的收键盘动画帧 —— 一律不许交接
    {
      label: '面板态 + 收键盘动画首帧',
      panelOpen: true,
      closing: true,
      inset: 280,
      handOff: false,
    },
    {
      label: '面板态 + 收键盘动画中间帧',
      panelOpen: true,
      closing: true,
      inset: 250,
      handOff: false,
    },
    { label: '面板态 + 收键盘动画尾帧', panelOpen: true, closing: true, inset: 60, handOff: false },
    { label: '面板态 + 收干净', panelOpen: true, closing: true, inset: 0, handOff: false },
    {
      label: '没有面板：无所谓交不交接',
      panelOpen: false,
      closing: false,
      inset: 280,
      handOff: false,
    },
    { label: '没有面板 + 收键盘', panelOpen: false, closing: true, inset: 250, handOff: false },
  ]

  for (const item of cases) {
    test(`交接判据：${item.label} → ${item.handOff}`, () => {
      expect({
        handOff: shouldHandOffToKeyboard({
          panelOpen: item.panelOpen,
          closing: item.closing,
          inset: item.inset,
        }),
      }).toEqual({ handOff: item.handOff })
    })
  }

  test('两条主路径的整条帧序列：键盘开着点「+」一次都不交接，面板态点输入框只交接一次', () => {
    /**
     * 路径 A：键盘开着（280）点「+」 —— 点「+」当拍 `collapseKeyboard()` 置 `closing`，平台随后
     * 报 250 / 180 / 60 / 0。这一段是**旧占用者退场**，面板必须一路留着，底座高度恒为面板高。
     */
    const openingPanel = [
      { inset: 280, closing: true },
      { inset: 250, closing: true },
      { inset: 180, closing: true },
      { inset: 60, closing: true },
      { inset: 0, closing: false },
    ]
    expect(
      openingPanel.map((frame) => shouldHandOffToKeyboard({ panelOpen: true, ...frame })),
    ).toEqual([false, false, false, false, false])

    /**
     * 路径 B：面板态点输入框 —— 直到键盘真落地那一帧才交接。按页面里的真实写法（判据成立就
     * 立刻把 `panelOpenRef` 写成 false）逐帧模拟，交接**恰好一次**，后续帧不再重复 setState。
     */
    const openingKeyboard = [
      { inset: 0, closing: false },
      { inset: 280, closing: false },
      { inset: 280, closing: false },
    ]
    let panelOpenRef = true
    const decisions = openingKeyboard.map((frame) => {
      const handOff = shouldHandOffToKeyboard({ panelOpen: panelOpenRef, ...frame })
      if (handOff) panelOpenRef = false
      return handOff
    })
    expect(decisions).toEqual([false, true, false])
    expect(decisions.filter(Boolean)).toHaveLength(1)
  })
})

describe('键盘高度阶梯：收起动画的中间值不许当终值（#560 安卓真机）', () => {
  type RunState = {
    inset: number
    closing: boolean
    closingFrom: number
    closedFrom: number
    closedAt: number
    aboveFrom: number
    pending: number
  }
  /** 一次事件里页面要回写的那几个字段（与 `nextKeyboardInset` 的输出同构） */
  const again = (step: ReturnType<typeof nextKeyboardInset>) => ({
    prev: step.inset,
    closing: step.closing,
    closingFrom: step.closingFrom,
    closedFrom: step.closedFrom,
    closedAt: step.closedAt,
    aboveFrom: step.aboveFrom,
    pending: step.pending,
  })
  /** `Partial<RunState>` → `nextKeyboardInset` 的入参（`inset` 在入参里叫 `prev`） */
  const againState = (state: Partial<RunState>) => ({
    prev: state.inset ?? 0,
    closing: state.closing ?? false,
    closingFrom: state.closingFrom ?? 0,
    closedFrom: state.closedFrom ?? 0,
    closedAt: state.closedAt ?? 0,
    aboveFrom: state.aboveFrom ?? 0,
    pending: state.pending ?? 0,
  })
  /** 按事件序列跑一遍阶梯 —— 页面 handler 做的就是把这几个字段原样回写 */
  const feed = (
    sequence: number[],
    start: Partial<RunState> & { now?: number[] } = {},
  ): { state: RunState; insets: number[]; changed: boolean[]; closings: boolean[] } => {
    let state: RunState = {
      inset: start.inset ?? 0,
      closing: start.closing ?? false,
      closingFrom: start.closingFrom ?? 0,
      closedFrom: start.closedFrom ?? 0,
      closedAt: start.closedAt ?? 0,
      aboveFrom: start.aboveFrom ?? 0,
      pending: start.pending ?? 0,
    }
    const insets: number[] = []
    const changed: boolean[] = []
    /**
     * 闩的**逐帧**轨迹。只看末态会漏掉「中途误置、下一个事件又自己解掉」的形态 —— 那正是
     * R1 的杀伤路径：变矮当收起之后，那一帧紧跟的变高会被丢弃（高度停在矮值），末态却仍然
     * 正常。所以每一条序列都要连闩一起断言。
     */
    const closings: boolean[] = []
    sequence.forEach((next, index) => {
      const step = nextKeyboardInset({
        prev: state.inset,
        closing: state.closing,
        closingFrom: state.closingFrom,
        closedFrom: state.closedFrom,
        closedAt: state.closedAt,
        aboveFrom: state.aboveFrom,
        pending: state.pending,
        next,
        now: start.now?.[index] ?? 1000 + index,
      })
      state = {
        inset: step.inset,
        closing: step.closing,
        closingFrom: step.closingFrom,
        closedFrom: step.closedFrom,
        closedAt: step.closedAt,
        aboveFrom: step.aboveFrom,
        pending: step.pending,
      }
      insets.push(step.inset)
      changed.push(step.changed)
      closings.push(step.closing)
    })
    return { state, insets, changed, closings }
  }
  /** 页面主动收过键盘之后的状态：闩已释放、尾巴窗口从 `closedAt` 起算 */
  const afterCollapse = (closedFrom: number, closedAt: number) =>
    ({
      inset: 0,
      closing: false,
      closingFrom: 0,
      closedFrom,
      closedAt,
      aboveFrom: 0,
      pending: 0,
    }) satisfies Partial<RunState>

  test('开键盘：一路跟着平台抬上去，每一档都要落地', () => {
    const run = feed([120, 260, 336])
    expect(run.insets).toEqual([120, 260, 336])
    expect(run.changed).toEqual([true, true, true])
    expect(run.state.closing).toBe(false)
  })

  test('同一个高度重复上报：不落地（页面据此跳过重指尾行）', () => {
    const run = feed([336, 336])
    expect(run.insets).toEqual([336, 336])
    expect(run.changed).toEqual([true, false])
  })

  test('换输入法 / 候选栏伸缩：键盘没关、只是变矮，之后变高必须跟回来（R1）', () => {
    const run = feed([300, 336], { inset: 336 })
    expect(run.insets).toEqual([300, 336])
    expect(run.changed).toEqual([true, true])
    // 每一帧都不许置闩：变矮不是「在收」
    expect(run.closings).toEqual([false, false])
    // 关键：变矮**不许**被当成「开始收起」—— 闩一旦误置，后面那个 336 会被丢弃，内边距停在
    // 300、更高的那把键盘把输入栏整条盖住，且只能靠彻底收键盘自愈
    expect(run.state.closing).toBe(false)
  })

  test('意图收起 336→300→180→0：单调向下，0 释放闩并记下尾巴窗口', () => {
    const run = feed([300, 180, 0], {
      inset: 336,
      closing: true,
      closingFrom: 336,
      now: [1000, 1100, 1300],
    })
    expect(run.insets).toEqual([300, 180, 0])
    expect(run.changed).toEqual([true, true, true])
    // 收藏起过程里闩一直按住，只有收到 0 才释放
    expect(run.closings).toEqual([true, true, false])
    expect(run.state.closing).toBe(false)
    expect(run.state.closedFrom).toBe(336)
    expect(run.state.closedAt).toBe(1300)
  })

  test('收起途中被抬 / 原地重复：丢弃且闩保持，继续变小才跟随', () => {
    const up = feed([300], { inset: 180, closing: true, closingFrom: 336 })
    expect(up.insets).toEqual([180])
    expect(up.changed).toEqual([false])
    expect(up.closings).toEqual([true])
    const same = feed([180], { inset: 180, closing: true, closingFrom: 336 })
    expect(same.insets).toEqual([180])
    expect(same.changed).toEqual([false])
    expect(same.closings).toEqual([true])
    const down = feed([90], { inset: 180, closing: true, closingFrom: 336 })
    expect(down.insets).toEqual([90])
    expect(down.changed).toEqual([true])
    expect(down.closings).toEqual([true])
  })

  test('收起途中键盘又被开回来：要连续两帧越过起点才认（G）', () => {
    const run = feed([336, 336], { inset: 200, closing: true, closingFrom: 336 })
    // 单帧越过起点还可能是收起动画里的抖动：第一帧丢弃，第二帧才承认键盘真回来了
    expect(run.insets).toEqual([200, 336])
    expect(run.changed).toEqual([false, true])
    expect(run.closings).toEqual([true, false])
    expect(run.state.closing).toBe(false)
  })

  test('收起动画里的单次越过不解闩，整段只许向下（G，bumpAboveFrom）', () => {
    const run = feed([336, 200, 340, 300, 180, 0], {
      inset: 336,
      closing: true,
      closingFrom: 336,
      now: [1000, 1010, 1020, 1030, 1040, 1300],
    })
    // 340 那一帧是抖动：丢弃（停在 200），后面接着变小，全程没有一次回抬
    expect(run.insets).toEqual([336, 200, 200, 200, 180, 0])
    expect(run.closings).toEqual([true, true, true, true, true, false])
  })

  test('0 是唯一的终点：只有报 0（或负数）才归零', () => {
    for (const closing of [false, true]) {
      const run = feed([0], { inset: 336, closing, closingFrom: 336 })
      expect(run.insets).toEqual([0])
      expect(run.changed).toEqual([true])
      expect(run.closings).toEqual([false])
    }
    const negative = feed([-12], { inset: 336, closing: true, closingFrom: 336 })
    expect(negative.insets).toEqual([0])
  })

  test('收完之后再开键盘：闩已释放，正常跟随', () => {
    const closed = feed([0], { inset: 60, closing: true, closingFrom: 336 })
    expect(closed.state.closing).toBe(false)
    // 窗口外（或比收完时更高）就是真的又开了键盘
    const reopened = nextKeyboardInset({ ...again(closed.state), next: 336, now: 2000 })
    expect(reopened.inset).toBe(336)
    expect(reopened.changed).toBe(true)
  })

  test('收尾尾巴（R3）：收完 400ms 内的动画残值丢弃，窗口外照收', () => {
    const closed = nextKeyboardInset({
      prev: 336,
      next: 0,
      closing: true,
      closingFrom: 336,
      closedFrom: 0,
      closedAt: 0,
      aboveFrom: 0,
      pending: 0,
      now: 1000,
    })
    expect(closed.closedFrom).toBe(336)
    // 窗口内、量级差得远（40 对 336）= 动画残值，丢弃（照收就是「先上提、再回落」原样复发）
    const tail = nextKeyboardInset({ ...again(closed), next: 40, now: 1200 })
    expect(tail.inset).toBe(0)
    expect(tail.changed).toBe(false)
    // 窗口外的同值照收：不是永久忽略，用户真的又开键盘必须跟得上
    const later = nextKeyboardInset({ ...again(closed), next: 40, now: 2000 })
    expect(later.inset).toBe(40)
    expect(later.changed).toBe(true)
    // 窗口内但比收完时更高 = 真的又开键盘，也照收
    const reopen = nextKeyboardInset({ ...again(closed), next: 336, now: 1200 })
    expect(reopen.inset).toBe(336)
    expect(reopen.changed).toBe(true)
  })

  test('收完立刻重开一把更矮的键盘：那是真高度，不是尾巴（R3 + B2）', () => {
    // 平台在收完之后稳定报 300（切到一把更矮的输入法/键盘）：只比「更矮」绝不能吞
    const run = feed([300, 300], afterCollapse(336, 1000), { now: [1100, 1200] })
    expect(run.insets).toEqual([300, 300])
    expect(run.changed).toEqual([true, false])
  })

  test('用户自己收键盘（没有意图闩）：尾巴窗口照样按「收完时的高度」判定（B4）', () => {
    // 系统自己收（返回键 / 点空白）时闩没置，`closedFrom` 必须取**收完前那一帧**的高度；
    // 取成 `closingFrom`（=0）则窗口形同虚设，尾巴 40 会被照收、抬出去 40px
    const run = feed([0, 40], {
      inset: 336,
      closing: false,
      now: [1000, 1080],
    })
    expect(run.insets).toEqual([0, 0])
    expect(run.changed).toEqual([true, false])
    expect(run.state.closedFrom).toBe(336)
  })

  test('收起起点只许原地保大：拿动画中间高度当起点，尾部的回抬就能提前解闩（E）', () => {
    // 连调两次「主动收键盘」时，第二次读到的 `from` 只是收起动画里的**中间高度**（200）。
    // 页面用 `Math.max(from, keyboardClosingFromRef.current)` 保住第一次的 336：
    // 于是尾部那一下 220 仍然低于起点、照旧丢弃。
    const kept = feed([220, 220], { inset: 200, closing: true, closingFrom: 336 })
    expect(kept.insets).toEqual([200, 200])
    expect(kept.closings).toEqual([true, true])
    // 反证：起点一旦被下修成 200，同一串 220 就「越过起点」、连两帧后被认作键盘重开、闩被解开
    const lowered = feed([220, 220], { inset: 200, closing: true, closingFrom: 200 })
    expect(lowered.closings).toEqual([true, false])
    expect(lowered.insets).toEqual([200, 220])
  })

  test('终值只上报一次：丢弃那一帧的高度必须留住，否则永久停在中间值（G）', () => {
    // 安卓实测形态：`[200, 340]` 之后平台不再报 —— 340 只来一次，两帧制会丢掉它。
    const run = feed([200, 340], { inset: 336, closing: true, closingFrom: 336 })
    expect(run.insets).toEqual([200, 200])
    expect(run.changed).toEqual([true, false])
    // 丢弃的是「立刻落地这个动作」，不是「这一个高度」：候选值留在 `pending` 里
    expect(run.state.pending).toBe(340)
    // 页面到点兜底时落 `max(当前, 候选)`，才不会停在 200 被 340 的键盘盖住 140px
    expect(Math.max(run.state.inset, run.state.pending)).toBe(340)
  })

  test('两帧制落地时取「候选值」与「本帧」的较大者', () => {
    // 上一帧丢弃时记下 340，这一帧报 340 → 落地 340（不是把候选值丢掉再落地 340 之外的值）
    const run = feed([340, 340], { inset: 200, closing: true, closingFrom: 336 })
    expect(run.insets).toEqual([200, 340])
    expect(run.changed).toEqual([false, true])
    expect(run.state.pending).toBe(0)
    expect(run.state.closing).toBe(false)
    // 候选值比落地帧更高时取候选值：340 是平台报过的真高度，不许被后面的 336 覆盖成更矮
    const higher = feed([340, 336], { inset: 200, closing: true, closingFrom: 336 })
    expect(higher.insets).toEqual([200, 340])
  })

  test('无闩落地时同样取较大者，不让陈旧候选把高度落小', () => {
    // 纯函数契约：任何「落地」帧都不许把值落到候选值以下（页面侧落地即清候选，这里直接喂）
    const step = nextKeyboardInset({
      prev: 200,
      next: 180,
      closing: false,
      closingFrom: 0,
      closedFrom: 0,
      closedAt: 0,
      aboveFrom: 0,
      pending: 340,
      now: 1000,
    })
    expect(step.inset).toBe(340)
    expect(step.changed).toBe(true)
    expect(step.pending).toBe(0)
  })

  test('收尾尾巴的量级阈值两侧（`closedFrom = 336` 时 168 / 169）', () => {
    const base = afterCollapse(336, 1000)
    // 恰好一半（168 * 2 = 336，不小于 336 的一半）→ 不是残值量级，算是真高度
    const half = nextKeyboardInset({ ...againState(base), next: 168, now: 1200 })
    expect(half.inset).toBe(168)
    expect(half.changed).toBe(true)
    // 再高一档（169 * 2 = 338 > 336）同样是真高度
    const above = nextKeyboardInset({ ...againState(base), next: 169, now: 1200 })
    expect(above.inset).toBe(169)
    // 更矮一档就落进残值量级（166 * 2 = 332 < 336）→ 丢弃
    const below = nextKeyboardInset({ ...againState(base), next: 166, now: 1200 })
    expect(below.inset).toBe(0)
    expect(below.changed).toBe(false)
  })

  test('闩在时的尾巴基准取「收起起点」，不是最后一档高度（V1b）', () => {
    // 起点 336、收到 180 之后再报 0：闭合基准必须是 336，否则窗口判据整体失效
    const run = feed([180, 0], { inset: 336, closing: true, closingFrom: 336 })
    expect(run.state.closedFrom).toBe(336)
    // 反证：若基准取最后一档 180，随后一把 168 的残值就会被当真高度照收
    expect(run.state.closedFrom).not.toBe(180)
  })

  test('收到 0 必须把候选值一起清掉（否则下一次开键盘会被旧候选顶高）', () => {
    // 336 时平台报 340（两帧制的丢弃帧）→ 候选 340；紧接着报 0（真收完了）
    const run = feed([340, 0], { inset: 336, closing: true, closingFrom: 336 })
    expect(run.insets).toEqual([336, 0])
    expect(run.state.pending).toBe(0)
    // 尾巴窗口早过（9999 - 1001），这一帧就是真高度：候选没清的话会被 max(100, 340) 顶成 340
    const reopened = feed([100], { ...run.state, now: [9999] })
    expect(reopened.insets).toEqual([100])
  })

  test('尾巴残值不许升格为候选值（收完的动画残值不是「平台报过的高度」）', () => {
    // 336 收完报 0（closedAt = 1000），100ms 后补报 100 —— 量级差得远，是动画尾巴
    const run = feed([0, 100], {
      inset: 336,
      closing: true,
      closingFrom: 336,
      now: [1000, 1100],
    })
    expect(run.insets).toEqual([0, 0])
    expect(run.state.pending).toBe(0)
    // 残值一旦进了候选，哨兵兜底时就会把这条动画尾巴当成「平台报过的真高度」落下去
    expect(
      resolveSentinel({
        closing: false,
        seen: 0,
        pending: run.state.pending,
        height: 0,
        focused: true,
        rearms: 0,
      }).inset,
    ).toBe(0)
  })

  test('丢弃帧的候选值取「最高的那一次」，不是最后一帧（抖动序列里末帧更低）', () => {
    // 已经抬高的 200 上连着报 250、240：两帧都属于「等第二帧」的丢弃帧，候选必须留 250
    const run = feed([250, 240], { inset: 200, closing: true, closingFrom: 336 })
    expect(run.insets).toEqual([200, 200])
    expect(run.state.pending).toBe(250)
  })

  test('尾巴窗口的边界恰好含 400ms（401ms 才是窗口外）', () => {
    // 收到 0 那一帧 closedAt = 1000，400ms 后（1400）补报 100 仍算动画尾巴
    const inside = feed([0, 100], { inset: 336, now: [1000, 1400] })
    expect(inside.insets).toEqual([0, 0])
    // 401ms 就是窗口外：同一把 100 的键盘要照收
    const outside = feed([0, 100], { inset: 336, now: [1000, 1401] })
    expect(outside.insets).toEqual([0, 100])
  })

  test('非有限值一律不动，交给下一次事件', () => {
    const idle = nextKeyboardInset({
      prev: 336,
      next: Number.NaN,
      closing: false,
      closingFrom: 0,
      closedFrom: 0,
      closedAt: 0,
      aboveFrom: 0,
      pending: 0,
      now: 1000,
    })
    expect(idle.inset).toBe(336)
    expect(idle.changed).toBe(false)
    const closingIdle = nextKeyboardInset({
      prev: 336,
      next: Number.NaN,
      closing: true,
      closingFrom: 336,
      closedFrom: 0,
      closedAt: 0,
      aboveFrom: 1,
      pending: 0,
      now: 1000,
    })
    expect(closingIdle.inset).toBe(336)
    expect(closingIdle.changed).toBe(false)
    expect(closingIdle.closing).toBe(true)
    // 抖动计数不能被一帧 NaN 清掉，否则「连两帧」的判据会被非有限值反复重置
    expect(closingIdle.aboveFrom).toBe(1)
  })
})

describe('活性哨兵的结论：只看「报过的最高值」与焦点（#560 B1）', () => {
  test('还在输入框里（聚焦）：绝不猜 0，落报过的最高真实值', () => {
    // 平台报过与当前值相等的同一把键盘（切语音 336 → 500ms 内点回输入框还是 336）
    const same = resolveSentinel({
      closing: true,
      seen: 336,
      pending: 0,
      height: 336,
      focused: true,
      rearms: 0,
    })
    expect(same.releaseLatch).toBe(true)
    expect(same.inset).toBe(336)
    // 报过中间值 300 然后静默、键盘其实还开着：落 300，绝不写 0
    const mid = resolveSentinel({
      closing: true,
      seen: 300,
      pending: 0,
      height: 300,
      focused: true,
      rearms: 0,
    })
    expect(mid.inset).toBe(300)
  })

  test('报过但没报满：直接用报过的值，不许退回当前高度（否则先回抬一整个周期）', () => {
    // 平台只报了 100 就静默，而页面当前高度还是 336（收起动画没走完就断了）
    const plan = resolveSentinel({
      closing: true,
      seen: 100,
      pending: 0,
      height: 336,
      focused: true,
      rearms: 0,
    })
    // 退回到 336 = 输入栏被抬回上一轮的高度、并且要挂到下一次事件才纠正（正是 #560 的观感）
    expect(plan).toEqual({ releaseLatch: true, inset: 100, rearms: 0 })
  })

  test('已经失焦：键盘该走，归零', () => {
    const plan = resolveSentinel({
      closing: true,
      seen: 300,
      pending: 0,
      height: 300,
      focused: false,
      rearms: 0,
    })
    expect(plan.releaseLatch).toBe(true)
    expect(plan.inset).toBe(0)
  })

  test('候选取值参与兜底：终值只报过一次时落在候选值上（G），且不许退回当前高度', () => {
    const plan = resolveSentinel({
      closing: true,
      seen: 200,
      pending: 340,
      height: 200,
      focused: true,
      rearms: 0,
    })
    expect(plan.inset).toBe(340)
    // 没报满（平台只报过 100，页面当前高度还是 336）：落 100。
    // 退回 336 = 输入栏先被抬回上一轮的高度、还要挂到下一次事件才纠正（正是 #560 的观感）。
    expect(
      resolveSentinel({
        closing: true,
        seen: 100,
        pending: 0,
        height: 336,
        focused: true,
        rearms: 0,
      }),
    ).toEqual({ releaseLatch: true, inset: 100, rearms: 0 })
  })

  test('既没上报过、又仍聚焦：这一拍不下结论，重发一次再判（第二个周期）', () => {
    const first = resolveSentinel({
      closing: true,
      seen: 0,
      pending: 0,
      height: 336,
      focused: true,
      rearms: 0,
    })
    expect(first.releaseLatch).toBe(true)
    // 不许归零、也不许动高度；要求页面重新武装一次
    expect(first.inset).toBe(336)
    expect(first.rearms).toBe(1)
    // 第二个周期到点还是什么都没有：接受现状（保持当前高度），不再无限重发
    const second = resolveSentinel({
      closing: true,
      seen: 0,
      pending: 0,
      height: 336,
      focused: true,
      rearms: 1,
    })
    expect(second.inset).toBe(336)
    expect(second.rearms).toBe(1)
  })

  test('闩本来就不在：什么都不做（不释放、不动高度）', () => {
    const plan = resolveSentinel({
      closing: false,
      seen: 0,
      pending: 0,
      height: 336,
      focused: false,
      rearms: 0,
    })
    expect(plan.releaseLatch).toBe(false)
    expect(plan.inset).toBe(336)
  })
})

describe('键盘高度是单一真源（#560）', () => {
  test('页面订阅设备级键盘高度事件，压成阶梯后再写，并在卸载时收回', async () => {
    const source = squash(await pageSource())
    const body = slice(source, 'const onHeightChange =', 'Taro.onKeyboardHeightChange')
    // 平台报来的原始值不能直接进布局：先过 `nextKeyboardInset`（判据本体在 view.ts 的表驱动单测里）
    expect(body).not.toContain('setKeyboardHeight(res.height')
    expect(body).toContain('const step = nextKeyboardInset({')
    expect(body).toContain('prev: keyboardHeightRef.current')
    expect(body).toContain('next: res.height')
    expect(body).toContain('closing: keyboardClosingRef.current')
    // 意图闩的起点与尾巴窗口都要喂进去，否则「键盘被开回来」「收尾尾巴」两条判据形同虚设
    expect(body).toContain('closingFrom: keyboardClosingFromRef.current')
    expect(body).toContain('closedFrom: keyboardClosedFromRef.current')
    expect(body).toContain('closedAt: keyboardClosedAtRef.current')
    // 「连续两帧越过起点」的计数也要喂进去、也要落盘，否则两帧永远等不到（G）
    expect(body).toContain('aboveFrom: keyboardAboveFromRef.current')
    expect(body).toContain('now: Date.now()')
    // 阶梯状态整份回写
    expect(body).toContain('keyboardClosingRef.current = step.closing')
    expect(body).toContain('keyboardClosingFromRef.current = step.closingFrom')
    expect(body).toContain('keyboardClosedFromRef.current = step.closedFrom')
    expect(body).toContain('keyboardClosedAtRef.current = step.closedAt')
    expect(body).toContain('keyboardAboveFromRef.current = step.aboveFrom')
    // 收到 0 就撤掉活性哨兵（R2 的清理点之一）
    expect(body).toContain('if (step.inset === 0) clearKeyboardSentinel()')
    /**
     * 落不落地只由纯函数的 `changed` 决定，而且**先判后写**：页面里没有第二条比较链，
     * 把 `keyboardHeightRef` 的回写挪到早退之前也废不掉阶梯（审查探针 1）。
     */
    expect(body).toContain('if (!step.changed) return')
    expect(body.indexOf('if (!step.changed) return')).toBeLessThan(
      body.indexOf('keyboardHeightRef.current = step.inset'),
    )
    expect(body).toContain('setKeyboardHeight(step.inset)')
    /**
     * 只要真落地了就重指尾行 —— 不是「只在收到 0 时」：开键盘时视口变矮同样要重锚（探针 2）。
     *
     * 但面板展开期间必须**跳过**（#597）：那一刻底部高度由面板占（`resolveBottomInset` 不看
     * 正在收缩的键盘），键盘往 0 收的每一档都不改变布局 —— 这几帧再翻尾行锚点，既把翻历史的
     * 用户拽回底部，又和面板那一次几何变化叠成「连着动两次」。
     */
    expect(body).not.toContain('setKeyboardHeight(step.inset) keepTailAnchored()')
    expect(body).toContain('if (!panelOpenRef.current) keepTailAnchored()')
    /**
     * 面板高度**不再**跟着键盘走（#597 追加任务）：三格图标按键盘高撑开会留一片空白。
     * 键盘事件里那条「见过的最高的键盘」的记录必须整段消失 —— 留着它面板就又被抬回键盘高。
     */
    expect(source).not.toContain('panelHeightPxRef')
    expect(source).not.toContain('setPanelHeightPx')
    expect(body).not.toContain('if (step.inset > panelHeightPxRef.current) {')
    /**
     * **面板 → 键盘**的交接（#597 F1）：收到「键盘真落地第一帧」才收面板，不在聚焦当拍收。
     * 当拍收的话底座从面板高直落 0（键盘高度此刻还是 0），视口先放大一整把键盘再缩回来。
     *
     * 判据本身在纯函数 `shouldHandOffToKeyboard` 里（P1）：页面只许**调用**它，不许自己写
     * 条件 —— 少一条 `!step.closing` 就会让「键盘开着点『+』」的收键盘动画帧被当成新键盘到了。
     * 上面那组表驱动直接钉住这条判据，这里钉的是「页面确实走它」。
     */
    expect(body).toContain('shouldHandOffToKeyboard({')
    expect(body).toContain('panelOpen: panelOpenRef.current')
    expect(body).toContain('closing: step.closing')
    expect(body).toContain('inset: step.inset')
    // 自己手写条件的老写法必须消失（回滚成它 = 丢掉 closing 判据）
    expect(body).not.toContain('if (panelOpenRef.current && step.inset > 0) {')
    expect(body).toContain('panelOpenRef.current = false')
    expect(body).toContain('setPanelOpen(false)')
    // 交接必须在「要不要重指尾行」之前：同一帧里先让位，那句判断才看得见 panelOpenRef=false
    expect(body.indexOf('shouldHandOffToKeyboard({')).toBeLessThan(
      body.indexOf('if (!panelOpenRef.current) keepTailAnchored()'),
    )
    expect(source).toContain('Taro.onKeyboardHeightChange(onHeightChange)')
    expect(source).toContain('Taro.offKeyboardHeightChange(onHeightChange)')
    // 卸载时把哨兵的定时器一起收掉（R2 清理点之二）
    expect(
      slice(source, 'Taro.offKeyboardHeightChange(onHeightChange)', '}, [clearKeyboardSentinel'),
    ).toContain('clearKeyboardSentinel()')
    // 基础库 < 2.7.0 没有这个 API：裸调会在挂载时抛 TypeError，整页白屏
    expect(source).toContain(
      "if (typeof Taro.onKeyboardHeightChange !== 'function') return undefined",
    )
  })

  test('页面主动收键盘只走一处：置意图闩 + 武装活性哨兵，且不自己归零高度', async () => {
    const source = squash(await pageSource())
    const body = slice(source, 'const collapseKeyboard = useCallback', '}, [armKeyboardSentinel])')
    // 只叫平台收，不自己归零（自己归零就是拿本页布局和系统收键盘动画抢时序）
    expect(body).toContain('void Taro.hideKeyboard()')
    expect(body).not.toContain('setKeyboardHeight')
    /**
     * 页面主动收起＝用户离开输入框：哨兵的意图信号必须跟着置假。
     * 切语音态会把 Textarea 卸载（React 卸载不合成 blur）、`hideKeyboard()` 本身也不 blur，
     * `togglePanel` 更是明确不 blur 输入框 —— 不置假的话焦点永远停在「真」，哨兵会把收起动画的
     * 中间值当终值落地，输入栏永久悬在空中。
     */
    expect(body).toContain('inputFocusedRef.current = false')
    // 意图闩只在这里置位：不从「高度变矮」反推（R1）
    expect(body).toContain('keyboardClosingRef.current = true')
    // 连调两次时第二次读到的 from 只是收起动画里的中间高度：只许取大，不许下修（E）
    expect(body).toContain(
      'keyboardClosingFromRef.current = Math.max(from, keyboardClosingFromRef.current)',
    )
    // 键盘本来就没开就不武装（否则 500ms 后白做一次重锚）
    expect(body).toContain('if (!(from > 0)) return')
    expect(body).toContain('armKeyboardSentinel()')
    /**
     * 页面新发起的一次收起要把重新武装**预算归零并抢在武装之前**：预算若留着上一轮的值
     * （或在武装之后才清），「哨兵 → 重发 → 哨兵」的链条就少一道闸，退化成无限重发。
     */
    expect(body).toContain('keyboardSentinelRearmsRef.current = 0')
    expect(body.indexOf('keyboardSentinelRearmsRef.current = 0')).toBeLessThan(
      body.indexOf('armKeyboardSentinel()'),
    )
    // 抖动计数必须在起点重算，否则上一轮收起动画里的越界帧会把这一轮的「连两帧」提前点亮
    expect(body).toContain('keyboardAboveFromRef.current = 0')
    // 两个调用点共用这一处，改一处不会漏另一处
    const voice = slice(source, 'const toggleVoiceMode = async', 'const onLongPressMessage')
    expect(voice).toContain('collapseKeyboard()')
    expect(voice).not.toContain('Taro.hideKeyboard(')
    // 收键盘必须与隐私授权查询**并行发起**（先收再 await 就是 #560 的时序 bug）
    expect(voice.indexOf('collapseKeyboard()')).toBeLessThan(
      voice.indexOf('if (privacyPendingRef.current) return'),
    )
    const panel = slice(source, 'const togglePanel = () => {', 'setPanelOpen(!panelOpen)')
    expect(panel).toContain('collapseKeyboard()')
    expect(panel).not.toContain('Taro.hideKeyboard(')
  })

  test('「页面主动收键盘」全页只有一条路径：hideKeyboard 只出现在收键盘处与重新武装处', async () => {
    const source = squash(await pageSource())
    /**
     * 这是**文件级**判据，不认位置：新增第三条绕过 `collapseKeyboard()` 直接调
     * `Taro.hideKeyboard()` 的路径（例如只在 `toggleVoiceMode` 里补一句）就会多出第三处 ——
     * 那条路径不会置意图闩、不会武装哨兵，等于把本轮修好的兜底绕开。
     */
    expect(source.split('Taro.hideKeyboard(').length - 1).toBe(2)
    expect(
      slice(source, 'const collapseKeyboard = useCallback', '}, [armKeyboardSentinel])'),
    ).toContain('Taro.hideKeyboard(')
    expect(
      slice(source, 'const armKeyboardSentinel = useCallback', '}, [clearKeyboardSentinel'),
    ).toContain('Taro.hideKeyboard(')
  })

  test('活性哨兵：到点先解闩，结论交给 resolveSentinel（平台不报 0 的卡死兜底，R2/B1）', async () => {
    const source = squash(await pageSource())
    const body = slice(
      source,
      'const armKeyboardSentinel = useCallback',
      '}, [clearKeyboardSentinel',
    )
    expect(
      slice(source, 'const clearKeyboardSentinel = useCallback', 'const armKeyboardSentinel'),
    ).toContain('clearTimeout')
    expect(body).toContain('KEYBOARD_SENTINEL_MS')
    /**
     * 判据不在页面里：只有 `resolveSentinel()` 一份（表驱动单测在上一节）。页面里再写一条
     * 「与快照比相等」之类比较链，就会退回到「报过且相等 → 猜 0 把输入栏埋掉」的死路。
     */
    expect(body).toContain('const plan = resolveSentinel({')
    expect(body).toContain('closing: keyboardClosingRef.current')
    expect(body).toContain('seen: keyboardSentinelMaxRef.current')
    expect(body).toContain('pending: keyboardPendingRef.current')
    expect(body).toContain('height: keyboardHeightRef.current')
    expect(body).toContain('focused: inputFocusedRef.current')
    expect(body).toContain('rearms: keyboardSentinelRearmsRef.current')
    // 到点无条件解闩：闩不能烂在定时器里；落哪个高度由结论决定
    expect(body).toContain('if (plan.releaseLatch) {')
    expect(body.indexOf('if (plan.releaseLatch) {')).toBeLessThan(
      body.indexOf('keyboardClosingRef.current = false'),
    )
    // 闩本来就不在：这一拍不下任何结论
    expect(body).toContain('if (!plan.releaseLatch) return')
    // 落地高度只允许走 `plan.inset`（不写死 0）
    expect(body).toContain('setKeyboardHeight(plan.inset)')
    expect(body).toContain('if (plan.inset !== keyboardHeightRef.current) {')
    expect(body).toContain('keepTailAnchored()')
    // 重新武装一个周期（不无限重发）：预算要落盘，且必须自己重发 hideKeyboard
    expect(body).toContain('if (plan.rearms > keyboardSentinelRearmsRef.current) {')
    expect(body).toContain('keyboardSentinelRearmsRef.current = plan.rearms')
    expect(body).toContain('void Taro.hideKeyboard()')
    /**
     * 重发这一支**不许复用 `collapseKeyboard()`** —— 它会把重新武装预算重置成 0，于是
     * 「哨兵 → 重发 → 哨兵」可以无限循环。`squash` 已剥掉注释，这里查的是真调用。
     */
    expect(body).not.toContain('collapseKeyboard')
    // 账本跟着哨兵一起清，否则是下一轮的假阳性
    expect(
      slice(source, 'const clearKeyboardSentinel = useCallback', 'const armKeyboardSentinel'),
    ).toContain('keyboardSentinelMaxRef.current = 0')
    expect(
      slice(source, 'const clearKeyboardSentinel = useCallback', 'const armKeyboardSentinel'),
    ).toContain('keyboardPendingRef.current = 0')
    // 页面被盖住也要收掉哨兵，并把重新武装预算与焦点一起清（R2 清理点之三）
    const hidden = slice(
      squash(await pageSource()),
      'useDidHide(() => {',
      'detailPollRef.current?.stop',
    )
    expect(hidden).toContain('clearKeyboardSentinel()')
    expect(hidden).toContain('inputFocusedRef.current = false')
    expect(hidden).toContain('keyboardSentinelRearmsRef.current = 0')
    // 超时常量在位（收键盘动画通常 200~300ms，留余量）
    expect(source).toContain('const KEYBOARD_SENTINEL_MS = 500')
  })

  test('哨兵账本必须写在 `changed` 早退之前（B1）', async () => {
    const source = squash(await pageSource())
    const body = slice(source, 'const onHeightChange =', 'Taro.onKeyboardHeightChange')
    // 被丢弃的那一帧恰恰是最需要记账的一帧（终值只报一次的形态全是丢弃帧）：
    // 把这两句挪到 `if (!step.changed) return` 之后，哨兵就永远看不到平台上报过什么。
    expect(body).toContain(
      'keyboardSentinelMaxRef.current = Math.max(keyboardSentinelMaxRef.current, step.inset)',
    )
    expect(body).toContain('keyboardPendingRef.current = step.pending')
    expect(body.indexOf('keyboardSentinelMaxRef.current = Math.max')).toBeLessThan(
      body.indexOf('if (!step.changed) return'),
    )
    expect(body.indexOf('keyboardPendingRef.current = step.pending')).toBeLessThan(
      body.indexOf('if (!step.changed) return'),
    )
    // 两帧制的计数同理：挪到早退之后 → 永远等不到第二帧，真重开永久被吞
    expect(body.indexOf('keyboardAboveFromRef.current = step.aboveFrom')).toBeLessThan(
      body.indexOf('if (!step.changed) return'),
    )
    // 候选值也要喂回纯函数，否则 `pending` 只进不出
    expect(body).toContain('pending: keyboardPendingRef.current')
  })

  test('焦点是哨兵唯一可信的意图信号：onFocus 置真、onBlur 置假（B1）', async () => {
    const source = squash(await pageSource())
    const focus = slice(source, 'onFocus={() => {', 'onInput=')
    expect(focus).toContain('inputFocusedRef.current = true')
    expect(focus).toContain('onBlur={() => {')
    expect(focus).toContain('inputFocusedRef.current = false')
  })

  test('用户点输入框＝明确要键盘：收尾尾巴窗口与意图闩立刻作废（B2）', async () => {
    const source = squash(await pageSource())
    const focus = slice(source, 'onFocus={() => {', 'onInput=')
    /**
     * #541 的契约（聚焦输入框算点面板外部）仍然成立，但**不在这一拍收**（#597 F1）：
     * 那一刻键盘高度还是 0，底座会直落到底、视口放大一整把键盘再被顶回来。收起推到了
     * 键盘真落地第一帧（键盘订阅里那条 `shouldHandOffToKeyboard(...)`）。
     *
     * 唯一的例外是**降级路径**（P2）：基础库 < 2.7.0 没有 `onKeyboardHeightChange`，订阅直接
     * 返回了，没有「键盘落地那一帧」可等 —— 那条路上只能在聚焦当拍收，否则 #541 彻底失效。
     * 所以这里钉的不是「onFocus 里没有 setPanelOpen」，而是「它只出现在那个降级守卫里、且只有
     * 一处」：既挡住退回「无条件当拍收」，也挡住删掉降级兜底。
     */
    expect(focus).toContain(
      "if (typeof Taro.onKeyboardHeightChange !== 'function') { keepTailAnchored() setPanelOpen(false) }",
    )
    expect(focus.split('setPanelOpen(false)')).toHaveLength(2)
    // 否则「刚收完键盘 400ms 内又点开一把更矮的键盘」会被尾巴判据吞掉，输入栏被新键盘盖住
    expect(focus).toContain('keyboardClosedAtRef.current = 0')
    expect(focus).toContain('keyboardClosingRef.current = false')
    expect(focus).toContain('keyboardClosingFromRef.current = 0')
    // 焦点=true 是哨兵唯一可信的意图信号；账本也要一起清，否则到点按旧账判
    expect(focus).toContain('inputFocusedRef.current = true')
    expect(focus).toContain('keyboardSentinelMaxRef.current = 0')
    expect(focus).toContain('keyboardPendingRef.current = 0')
  })

  test('重锚的异步回读按序号作废旧结论（收键盘期间会连着换锚，R5）', async () => {
    const body = slice(squash(await pageSource()), 'const keepTailAnchored = useCallback', '}, [])')
    expect(body).toContain('const seq = ++anchorSeqRef.current')
    expect(body).toContain('if (seq !== anchorSeqRef.current) return')
    // 序号守卫必须早于任何写回：过期结论不许改滚动位置
    expect(body.indexOf('if (seq !== anchorSeqRef.current) return')).toBeLessThan(
      body.indexOf('setScrollRestore('),
    )
  })

  test('页面被盖住时连同步镜像与「正在收起」闩一起清，回来才跟得上', async () => {
    const body = slice(
      squash(await pageSource()),
      'useDidHide(() => {',
      'detailPollRef.current?.stop',
    )
    expect(body).toContain('keyboardClosingRef.current = false')
    expect(body).toContain('keyboardClosingFromRef.current = 0')
    expect(body).toContain('keyboardClosedAtRef.current = 0')
    // 两帧制的计数也要清：留着半截计数，回来第一次「越过起点」就会被当成键盘重开
    expect(body).toContain('keyboardAboveFromRef.current = 0')
    expect(body).toContain('keyboardHeightRef.current = 0')
    expect(body).toContain('setKeyboardHeight(0)')
    // 哨兵的账本 / 重新武装预算 / 焦点一起清（B1：脏账本是下一轮的假阳性）
    expect(body).toContain('clearKeyboardSentinel()')
    expect(body).toContain('keyboardSentinelRearmsRef.current = 0')
    expect(body).toContain('inputFocusedRef.current = false')
  })

  test('底部底座的让高样式由纯函数派生，收起态交给 scss 的安全区（#577）', async () => {
    const source = squash(await pageSource())
    // 标签跨多行，`tag()` 切不准：切到下一个子节点为止
    const bar = slice(source, '<View className="conv__bar"', '{recording ?')
    // 内联样式整段来自纯函数（两条分支、含「安全区只算一次」的口径都在 view.ts 里）：
    // 页面里不许再自己现算条件，否则「回滚这一行」除了源码钉桩没人测得到
    expect(bar).toContain('style={bottomReserve.bar}')
    expect(source).toContain('<View className="conv__bottom" style={bottomReserve.bottom}>')
    expect(source).toContain('const bottomReserve = resolveBottomReserveStyles(bottomInset)')
    expect(source).toContain(
      'const bottomInset = resolveBottomInset({ panelOpen, keyboardHeight, panelHeight,',
    )
    // 面板高度从窗口宽度 + 安全区算一次（#597 追加任务）：不再依赖「见过的最高的键盘」
    expect(source).toContain('const panelHeight = useMemo(')
    expect(source).toContain(
      'resolvePanelHeightPx({ windowWidth: info.windowWidth, safeAreaBottom })',
    )
    // 收起态不内联任何值，安全区由底座那条 env 内边距照旧生效（#577：只算这一次）
    const style = squash(await styleSource())
    expect(slice(style, '.conv__bottom {', '}')).toContain(
      'padding-bottom: env(safe-area-inset-bottom)',
    )
    // 输入栏自己不再算安全区：写了就是跟底座重复计数
    expect(slice(style, '.conv__bar {', '}')).not.toContain('env(safe-area-inset-bottom)')
  })

  test('面板是底部底座里的吸底浮层，不在输入栏的文档流里（#597）', async () => {
    const source = squash(await pageSource())
    const style = await styleSource()
    // 结构：面板与输入栏同一个父级（`.conv__bottom`，内联让高由 #577 的纯函数给）
    expect(source).toContain('<View className="conv__bottom" style={bottomReserve.bottom}>')
    /**
     * 面板高度由**内容自己撑开**（#597 追加任务）：不能再内联「上次键盘高」，
     * 否则三格图标下面又是一片空白（Owner 的演示截图）。
     */
    expect(
      tag(source, '<View className="conv__panel"').startsWith('<View className="conv__panel">'),
    ).toBe(true)
    // 面板必须**在输入栏之外**：`.conv__bar` 的片段一直切到面板标签之前，中间得先出现底座的闭合
    const barToPanel = slice(source, '<View className="conv__bar"', '<View className="conv__panel"')
    expect(barToPanel).toContain('</View> </View>')
    // 样式：面板绝对定位贴底、高度由内容决定；容器提供定位父级
    const panel = style.slice(
      style.indexOf('.conv__panel {'),
      style.indexOf('}', style.indexOf('.conv__panel {')),
    )
    expect(panel).toContain('position: absolute')
    expect(panel).toContain('bottom: 0')
    // 高度不能写死在样式里（底座让位带的高度是运行期按窗口宽度 / 安全区算的）
    expect(panel).not.toContain('height:')
    expect(
      style.slice(
        style.indexOf('.conv__bottom {'),
        style.indexOf('}', style.indexOf('.conv__bottom {')),
      ),
    ).toContain('position: relative')
    // 流内块时代的 `margin-top` 会把面板从底边顶开，与内联高度叠加就是一条缝
    expect(panel).not.toContain('margin-top')
  })

  test('面板落地后按「展开当拍是否贴底」再锚一次尾行（#597 追加任务）', async () => {
    /**
     * `togglePanel` 里那次 `keepTailAnchored()` 跑在 `setPanelOpen` **之前**，锚的是「面板还没
     * 占位」的旧几何；面板一落地消息流又矮一截，最后一条就被输入栏截掉了。所以展开当拍记一份
     * 贴底快照，等面板几何落地那一次量测再按它补锚一次。
     *
     * 记的必须是**判据**：翻历史翻到一半的人，展开面板后不许被拽回底部（#597 现象三）。
     */
    const source = squash(await pageSource())
    // 快照本身要有存放处
    expect(source).toContain('const panelOpenStickRef = useRef(false)')
    const toggle = slice(source, 'const togglePanel = () => {', 'const dismissPanel = () => {')
    // 只在**展开**分支里记（收起不需要：视口变高不会截断尾行）
    expect(toggle).toContain('panelOpenStickRef.current = stickBottomRef.current')
    expect(toggle.indexOf('panelOpenStickRef.current = stickBottomRef.current')).toBeLessThan(
      toggle.indexOf('setPanelOpen(!panelOpen)'),
    )
    // 落地后取走标志：三个条件缺一不可（是面板引起的几何变化 / 面板确实开着 / 当时贴底）
    const measure = slice(
      source,
      'const panelTransition = panelGeomRef.current',
      'bottomGapAllowanceRef.current = mergeViewportShrink({',
    )
    expect(measure).toContain(
      'const reopenTailAnchor = panelTransition && panelOpenRef.current && panelOpenStickRef.current',
    )
    expect(measure).toContain('if (reopenTailAnchor) panelOpenStickRef.current = false')
    // 补锚必须发生在**量完几何之后**：这一帧的视口才是最终几何
    const exec = slice(source, 'const reopenTailAnchor', '}, [keyboardHeight, panelOpen')
    expect(exec).toContain('if (reopenTailAnchor) keepTailAnchored()')
    expect(exec.indexOf('writeInputRowPx(inputHeight)')).toBeLessThan(
      exec.indexOf('if (reopenTailAnchor) keepTailAnchored()'),
    )
  })

  test('输入框不再让平台自己推页面（两套补偿叠加就是抽搐的来源）', async () => {
    const textarea = tag(squash(await pageSource()), '<Textarea')
    expect(textarea).toContain('className="conv__input"')
    expect(textarea).toContain('adjustPosition={false}')
    expect(textarea).toContain('cursorSpacing={0}')
  })

  test('两态不卸载输入框：语音态只把它藏起来（挂载瞬态就是「先上提再回落」的根因）', async () => {
    const source = squash(await pageSource())
    // 输入框每多一行就往回报一次实测高度（设备 px），比在渲染期猜行数准。
    // `tag()` 会在 `onLineChange` 里的 `>` 处截断，切到下一个属性为止
    const textarea = slice(source, '<Textarea', 'onFocus=')
    expect(textarea).toContain('if (!(height > 0)) return')
    expect(textarea).toContain('writeInputRowPx(height)')
    // 长高的那一刻先把「本页让出的高度」记进贴底容差，再更新真源（顺序反了就等于没记）。
    // 记账口径本身在 `view.ts` 的 `growBottomAllowance()`（表驱动单测在上面）
    expect(textarea).toContain(
      'bottomGapAllowanceRef.current = growBottomAllowance({ allowance: ' +
        'bottomGapAllowanceRef.current, prevInputPx: inputRowPxRef.current,',
    )
    const grownAt = textarea.indexOf('growBottomAllowance({')
    expect(grownAt).toBeGreaterThan(-1)
    expect(grownAt).toBeLessThan(textarea.indexOf('writeInputRowPx(height)'))

    /**
     * 结构判据（顶替原来的「语音态用 `inputRowPx` 顶 `minHeight`」）：
     * 卸载重挂 `<Textarea autoHeight>`，新节点在拿到真实宽度前会按最窄宽排版、把占位文字
     * 折成三行报 85/100，下一拍才塌回 48 —— 输入栏那一帧「先上提再回落」就是它。所以
     * 输入框必须**常驻**：全页只有一个 `<Textarea>`，且它不在任何条件渲染里。
     */
    expect(source.split('<Textarea').length - 1).toBe(1)
    const rowwrap = slice(source, '<View className="conv__rowwrap">', 'onLineChange=')
    expect(rowwrap).toContain('<Textarea')
    // 语音态那支在输入框之前就关掉了（`) : null}`）：输入框不在 `voiceMode ?` 的分支里
    const holdToTextarea = slice(source, 'onTouchCancel={() => finishVoice(true)}', '<Textarea')
    expect(holdToTextarea).toContain(') : null}')
    // 语音态只藏不卸载：藏了还要让出手势，否则原生输入框的点击层照样抢焦点
    expect(rowwrap).toContain('style={voiceMode ? { opacity: 0, pointerEvents: ')

    /**
     * scss 侧同样钉住：`conv__rowwrap` 是「按住说话」的定位父级；`.conv__hold` 改成盖满整行
     * 的绝对定位块、**不再写死 68**（否则多行草稿切语音时手势区矮一截）；输入框的
     * `min-height` 保留 —— 单行时输入栏高度必须还是「控件高」这个数（#577 起走 token，
     * 与三颗钮同源，见 `conversation-bottom-bar-layout.test.ts`）。
     */
    const style = squash(await styleSource())
    expect(slice(style, '.conv__rowwrap {', '}')).toContain('position: relative')
    const holdStyle = slice(style, '.conv__hold {', '&:active')
    expect(holdStyle).toContain('position: absolute')
    expect(holdStyle).not.toContain('height: 68px')
    expect(slice(style, '.conv__input {', '}')).toContain('min-height: $bar-control-px')
  })

  test('发送清空输入后，输入行高度真源跟着回落（否则下一轮切语音又把消息流顶矮一截）', async () => {
    const body = slice(squash(await pageSource()), 'const send = () => {', 'doSend(text')
    expect(body).toContain("setInputValue('')")
    expect(body).toContain('setInputRowPx(0)')
    // 同步镜像也要清：留着旧的多行高度，「这次长高多少」会从旧值起算而算成 0
    expect(body).toContain('inputRowPxRef.current = 0')
  })

  test('换身份也把输入行高度真源与滚动状态清掉（下一个身份不该继承上一份草稿与偏移）', async () => {
    const body = slice(
      squash(await pageSource()),
      'deferredRef.current = resetDeferredReload(epoch.current)',
      'setPending([])',
    )
    expect(body).toContain("setInputValue('')")
    expect(body).toContain('setInputRowPx(0)')
    expect(body).toContain('inputRowPxRef.current = 0')
    // 复位指令用过不撤，是本页唯一不再自动回落的滚动状态：不清就会被下一个身份沿用
    expect(body).toContain('setScrollRestore(null)')
    expect(body).toContain('scrollTopRef.current = 0')
    expect(body).toContain('bottomGapAllowanceRef.current = 0')
  })

  test('切语音态：点击当拍收键盘，高度真源交给平台事件收回（自己归零就是拿布局抢时序）', async () => {
    const body = slice(
      squash(await pageSource()),
      'const toggleVoiceMode = async',
      'const onLongPressMessage',
    )
    const hideAt = body.indexOf('collapseKeyboard()')
    const gateAt = body.indexOf('getPrivacyAuthorizationState()')
    expect(hideAt).toBeGreaterThan(-1)
    // 收键盘是纯原生动作，不碰本页布局：点击当拍就发，不等授权那趟 await
    expect(hideAt).toBeLessThan(gateAt)
    /**
     * 整条切态路径一次都不许写高度真源：写了就是拿本页布局去和系统收键盘的动画抢时序 ——
     * 安卓真机上的「先上提、再回落」正是这么拼出来的。高度只由 `onKeyboardHeightChange` 收。
     */
    expect(body).not.toContain('setKeyboardHeight')
    // 切态那一批仍然是这三样，一起落地
    expect(body).toContain('keepTailAnchored()')
    expect(body).toContain('setPanelOpen(false)')
    expect(body).toContain('setVoiceMode(true)')
    // 隐私授权的判据本身不变（仍由 canEnterVoiceMode 决定是否落地语音态）
    expect(body).toContain(
      'canEnterVoiceMode(state, seq, voiceGateSeqRef.current, aliveRef.current)',
    )
  })
})

describe('「+」面板与贴底（#561）', () => {
  test('开面板前先收键盘，重指尾行与开面板同批落地；高度同样交给平台事件', async () => {
    const body = slice(
      squash(await pageSource()),
      'const togglePanel = () => {',
      'setPanelOpen(!panelOpen)',
    )
    const hideAt = body.indexOf('collapseKeyboard()')
    const anchorAt = body.indexOf('keepTailAnchored()')
    expect(hideAt).toBeGreaterThan(-1)
    expect(anchorAt).toBeGreaterThan(hideAt)
    // 与切语音态同一口径：面板这条路径也不许自己归零高度真源
    expect(body).not.toContain('setKeyboardHeight')
  })

  test('贴底才重指尾行；换锚后直接认定贴底，不等一条可能永远不来的滚动事件', async () => {
    const body = slice(squash(await pageSource()), 'const keepTailAnchored = useCallback', '}, [])')
    // 翻历史时不动位置（守卫仍在）
    expect(body).toContain('if (stick) {')
    expect(body).toContain('setTailAnchorFlip((prev) => !prev)')
    // 换锚之后贴底就是已知事实：`onScroll` 不一定会因程序化滚动而回吐事件
    expect(body).toContain('stickBottomRef.current = true')
  })

  test('几何变化后回读偏移：原生层把偏移丢了就补回来，没丢什么都不做', async () => {
    const source = squash(await pageSource())
    const body = slice(source, 'const keepTailAnchored = useCallback', '}, [])')
    // 一拍一张快照：`prevTop` 与 `stick` 都取调用时的值，两者不能一个取快照一个现读
    expect(body).toContain(
      'const prevTop = scrollTopRef.current const stick = stickBottomRef.current',
    )
    /**
     * 回读整段必须**无条件**紧接换锚执行，且回调体内部不许再插一层判断。
     *
     * 取整段连续文本而不是零散子串：外面套一层 `if (false)` / 回调首行插一句 `return`，
     * 或者把 `planScrollFix(...)` 包进三元表达式，都会打断这段连续性 —— 而这几种改法
     * 此前全是绿的（端上表现为「偶尔跳回顶部」，任何单点断言都看不出来）。
     */
    expect(body).toContain(
      'void Taro.nextTick(() => { Taro.createSelectorQuery() ' +
        ".select('.conv__scroll') .scrollOffset() .exec((res) => { " +
        'if (!aliveRef.current) return ' +
        'if (seq !== anchorSeqRef.current) return ' +
        'const offset = res?.[0] as { scrollTop?: number } | undefined ' +
        'const fix = planScrollFix({ prevTop, top: offset?.scrollTop ?? Number.NaN, stick }) ' +
        'bottomGapAllowanceRef.current = 0 ' +
        "if (fix.kind === 'anchor')",
    )
    // 判据本身在 `view.ts`（表驱动单测在上面），这里钉「三支都往下走了、写回的是哪个值」
    expect(body).toContain(
      "if (fix.kind === 'anchor') { setTailAnchorFlip((prev) => !prev) return }",
    )
    expect(body).toContain(
      "if (fix.kind === 'restore') { setScrollRestore((prev) => ({ top: fix.top, " +
        'tick: (prev?.tick ?? 0) + 1 }))',
    )
    // 复位指令**用后不撤**：撤掉等于让属性回到默认的 0，正是本票要修的「偏移掉成 0」形态。
    // 只扫 `keepTailAnchored` 体内 —— 换身份清场（另一条用例）确实要清掉残留的复位值
    expect(body).not.toContain('setScrollRestore(null)')
  })

  test('消息流有 onScroll，并把 scrollTop/scrollHeight/视口高度喂给贴底判据', async () => {
    const source = squash(await pageSource())
    expect(tag(source, '<ScrollView')).toContain('onScroll={onScroll}')
    const body = slice(source, 'const onScroll = useCallback', '}, [])')
    expect(body).toContain('scrollTopRef.current = scrollTop')
    expect(body).toContain('scrollHeight')
    expect(body).toContain('viewportHeight: scrollViewportRef.current')
    expect(body).toContain('isNearBottom(')
    // 本页自己造成的视口缩量算进容差；真到底了归零，免得长期放宽
    expect(body).toContain('Math.max(BOTTOM_SLACK_PX, bottomGapAllowanceRef.current)')
    expect(body).toContain('bottomGapAllowanceRef.current = 0')
    // 标志的取值交给 `view.ts` 的纯函数（表驱动单测在上面），组件里不许自己决断
    expect(body).toContain('stickBottomRef.current = stickAfterScroll(nearBottom)')
  })

  test('首次量测不算「缩量」：视口高度从 ref 的 0 长起来时不能一次性放宽到整屏', async () => {
    const body = slice(squash(await pageSource()), 'const viewport = res?.[0]', 'const inputRow')
    // 口径在 `view.ts` 的 `mergeViewportShrink()`（表驱动单测在上面）：首帧 prev 为 0 不记、
    // 取大不覆盖、只认缩量
    expect(body).toContain(
      'bottomGapAllowanceRef.current = mergeViewportShrink({ allowance: ' +
        'bottomGapAllowanceRef.current, prevViewport: scrollViewportRef.current,',
    )
    expect(body).toContain('nextViewport: viewport.height')
    expect(body).toContain('scrollViewportRef.current = viewport.height')
  })

  test('尾行锚点带 keyId 且能交替：内容追加与几何变化都能重新滚到底', async () => {
    const source = squash(await pageSource())
    // `${` 拆成两段拼，免得被当成模板串插值
    expect(source).toContain(
      'const tailAnchorId = tail ? `conv-tail-$' +
        '{tail.keyId}-$' +
        "{tailAnchorFlip ? 'b' : 'a'}` : ''",
    )
    expect(source).toContain(
      'const scrollTarget = jumpTo && jumpTo.tail === tailId ? jumpTo.id : tailAnchorId',
    )
    // 锚点挂在 ScrollView 里、消息流最末（零尺寸，滚到它就是滚到底）
    expect(source).toContain('{tailAnchorId ? <View id={tailAnchorId} /> : null}')
  })

  test('两条收面板的路径走同一个重锚守卫，且都不碰输入文字 / 不 blur（#541 契约）', async () => {
    const body = slice(squash(await pageSource()), 'const dismissPanel = () => {', '}')
    expect(body).toContain('keepTailAnchored()')
    expect(body).toContain('setPanelOpen(false)')
    expect(body).not.toContain('setInputValue')
  })

  test('偏移复位只走 scrollTop 属性，靠 0.5px 交替让「同一个位置」也再下发一次', async () => {
    const source = squash(await pageSource())
    expect(tag(source, '<ScrollView')).toContain('scrollTop={restoreScrollTop}')
    expect(source).toContain('restoreScrollTop = scrollRestore')
    expect(source).toContain('scrollRestore.tick % 2 === 0 ? 0 : 0.5')
  })
})
