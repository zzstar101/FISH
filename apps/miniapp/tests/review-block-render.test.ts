import { describe, expect, mock, test } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * 面交页「交易评价」块的**渲染级**回归（#485 审查 P1-2 / P2-8）。
 *
 * 被钉的事实：**评价弹层不随对账块的重读卸载**。
 *
 * 旧实现里 loading 走早退 `return null`，而弹层画在同一组件的返回体里 ——
 * 于是「弹层开着的时候返回本页」（页面 `useDidShow` 自增 show 代次 → `reloadSignal` 变
 * → effect 先 `setState({state:'loading'})`）会让弹层先被卸载、fetch 回来再重新挂载。
 * `dialogOpen` 是块自己的 state、不复位，所以弹层会「闪断重现」，里面已选的图与在途上传
 * 全部销毁。这条链在源码字符串断言（`order-list-state.test.ts` 的手法）下是**全绿**的，
 * 只有真渲染才看得出来。
 *
 * 两道网，因为 bug 的形态分布在两处：
 * 1. **渲染级**：`MeetupReviewSections` 真渲染（`react-dom/server` 的静态渲染，
 *    与 `apps/web-pc` 的 `*.test.tsx` 同一手法；渲染期无副作用，`previewImage` 只挂在
 *    onClick 上不会被触发）。被替换的只有脚下两层：Taro 组件用最小 DOM 替身（本仓无 jsdom），
 *    `ReviewDialog` 用真组件（它自己带一整套上传/提交编排，编排逻辑属于
 *    `order-list-state.test.ts` 与 `review-media-upload.test.ts` 的范围）。
 *    断言 loading / failed / ready 三态下弹层都还在。
 * 2. **结构级**：default export（承载 `dialogOpen` 的那个组件）的渲染体必须**只有一处
 *    无条件调用**。它的 state 从外部不可置（加测试专用 props 只为测这个不值），所以
 *    这里钉住形状 —— 正是「早退发生在这一层」才让弹层被卸载。
 */

mock.module('@tarojs/components', () => ({
  View: (props: Record<string, unknown>) =>
    createElement('view', { className: props.className }, props.children as ReactNode),
  Text: (props: Record<string, unknown>) =>
    createElement('text', { className: props.className }, props.children as ReactNode),
  Image: (props: Record<string, unknown>) =>
    createElement('img', { className: props.className, src: props.src }),
  Textarea: (props: Record<string, unknown>) =>
    createElement('textarea', { className: props.className }),
}))

mock.module('@tarojs/taro', () => ({
  default: {
    previewImage: () => Promise.resolve(),
    showToast: () => Promise.resolve(),
    showModal: () => Promise.resolve({ confirm: false }),
    getFileSystemManager: () => ({ readFile: () => {} }),
    request: () => Promise.resolve({ statusCode: 200 }),
    getStorageSync: () => '',
    setStorageSync: () => {},
  },
}))

// 构建期注入的开关（`config/index.ts` 的 defineConstants）：真弹层经 `features/auth/store`
// 静态拖着 `features/auth/demo.ts`，它在模块求值阶段就读 `__DEMO_AUTH__`；不定义会在
// import 时 ReferenceError（同 `wishes-api.test.ts` / `order-list-state.test.ts`）。
Object.assign(globalThis, { __DEMO_AUTH__: false, __ALLOW_MOCK_FALLBACK__: true })

const { MeetupReviewSections } = await import(
  '../src/pkg-trade/pages/transaction-meetup/review-block'
)

function sections(overrides: {
  state: Parameters<typeof MeetupReviewSections>[0]['state']
  dialogOpen: boolean
}) {
  return createElement(MeetupReviewSections, {
    state: overrides.state,
    dialogOpen: overrides.dialogOpen,
    transactionId: '01930000-0000-7000-8000-00000000c0de',
    listingTitle: '斯伯丁篮球',
    onRetry: () => {},
    onOpenDialog: () => {},
    onCloseDialog: () => {},
    onSubmitted: () => {},
    onImageError: () => {},
  })
}

/** 弹层在不在（`review-block.tsx` 里 import 的就是真弹层 —— 这里断言它的挂载，不 mock 它） */
function hasDialog(html: string): boolean {
  return html.includes('rvw__dialog')
}

describe('MeetupReviewSections —— 弹层与卡片区是兄弟（重读不卸载弹层）', () => {
  test('重读中（loading）：弹层仍在（旧实现里这一帧返回 null，弹层随之被卸载）', () => {
    const html = renderToStaticMarkup(sections({ state: { state: 'loading' }, dialogOpen: true }))
    expect(hasDialog(html)).toBe(true)
    // 卡片区在 loading 时不画（避免闪一帧空卡）——它与弹层是两件事
    expect(html).not.toContain('meetup__rvcard')
  })

  test('读失败（failed）：弹层仍在，卡片区换成可重试说明', () => {
    const html = renderToStaticMarkup(sections({ state: { state: 'failed' }, dialogOpen: true }))
    expect(hasDialog(html)).toBe(true)
    expect(html).toContain('交易评价加载失败，点按重试')
  })

  test('读成功（ready）：弹层与两行对账一起画', () => {
    const html = renderToStaticMarkup(
      sections({
        state: {
          state: 'ready',
          mine: { rating: 'POSITIVE', body: '', images: [] },
          theirs: null,
        },
        dialogOpen: true,
      }),
    )
    expect(hasDialog(html)).toBe(true)
    expect(html).toContain('我的评价')
    expect(html).toContain('对方的评价')
  })

  test('弹层没打开时三态都不画它（开关只有 dialogOpen 一个）', () => {
    const states = [
      { state: 'loading' as const },
      { state: 'failed' as const },
      { state: 'ready' as const, mine: null, theirs: null },
    ]
    for (const state of states) {
      const html = renderToStaticMarkup(sections({ state, dialogOpen: false }))
      expect(hasDialog(html)).toBe(false)
      // 探针自检：同一个 DOM 提取器在「弹层该在」时确实能认出来，否则上面的 false 是假的
      const open = renderToStaticMarkup(sections({ state, dialogOpen: true }))
      expect(hasDialog(open)).toBe(true)
    }
  })

  test('我方未评时给「写评价」入口；对方未评给说明文案', () => {
    const html = renderToStaticMarkup(
      sections({
        state: { state: 'ready', mine: null, theirs: null },
        dialogOpen: false,
      }),
    )
    expect(html).toContain('写评价')
    expect(html).toContain('对方还没评价')
  })
})

/**
 * 结构级第二道网：default export 的渲染体。
 *
 * 上面那组用例只渲染 `MeetupReviewSections`。让原始 bug 复活的**唯一位置**是承载
 * `dialogOpen` 的 default export —— 在它里面加一句 `if (state.state === 'loading') return null`
 * （即旧写法）会让弹层随重读卸载，而上面 5 条用例仍然全绿（实测）。
 *
 * default export 的 state 从外部置不了（`state` 由 useEffect 里的 fetch 决定），
 * 为测这一条给它加测试专用 props 不划算；所以这里钉**形状**：
 * 该组件必须只把渲染交给 `MeetupReviewSections`，且那一处没有前置早退。
 */
describe('MeetupReviewBlock（default export）—— 渲染体必须是唯一一处、无条件', () => {
  async function blockSource(): Promise<string> {
    return await Bun.file(
      new URL('../src/pkg-trade/pages/transaction-meetup/review-block.tsx', import.meta.url),
    ).text()
  }

  /** 去掉注释：源码正逐段解释这些机制，含注释即可蒙混过关 */
  function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  }

  test('default export 里只有一处 render 出口，且它无条件调用 MeetupReviewSections', async () => {
    const code = codeOnly(await blockSource())
    // 从 default export 的函数体开始（`MeetupReviewSections` 那个 export 在其之前）
    const start = code.indexOf('export default function MeetupReviewBlock')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = code.slice(start)

    // ① 只有一个 JSX 渲染出口（`return (` 后跟 `<`）：多出来的那处（无论是早退还是别的
    //    分支）都会让弹层有第二条逃生路径。用后跟 `<` 收窄：useEffect 清理函数的
    //    `return () => {` 是普通返回，不该算进渲染出口。
    const returns = body.match(/return \(\s*</g) ?? []
    expect(returns, `default export 里出现了 ${returns.length} 处渲染出口`).toHaveLength(1)

    // ② 该出口之前没有任何 `return null` / `return <`：早退正是把弹层拽掉的机制
    const beforeReturn = body.slice(0, body.search(/return \(\s*</))
    expect(beforeReturn).not.toMatch(/return\s+null/)
    expect(beforeReturn).not.toMatch(/return\s+</)

    // ③ 出口画的就是 MeetupReviewSections（不是别的东西，也不是条件渲染）
    const renderBlock = body.slice(body.search(/return \(\s*</))
    const sectionsAt = renderBlock.indexOf('<MeetupReviewSections')
    expect(
      sectionsAt,
      'default export 的渲染出口必须交给 MeetupReviewSections',
    ).toBeGreaterThanOrEqual(0)
    // 条件渲染（三元 / &&）会重新引入「某态下不画」的分支
    expect(renderBlock.slice(0, sectionsAt)).not.toMatch(/\?\s*\(|&&\s*\(/)
  })

  test('弹层在不在只由 dialogOpen 决定：sections 里 ReviewDialog 的渲染条件只读它', async () => {
    const code = codeOnly(await blockSource())
    const start = code.indexOf('export function MeetupReviewSections')
    const end = code.indexOf('export default function MeetupReviewBlock')
    const body = code.slice(start, end)
    const dialogAt = body.indexOf('<ReviewDialog')
    expect(dialogAt, 'sections 里应有 ReviewDialog').toBeGreaterThanOrEqual(0)
    const guard = body.slice(0, dialogAt)
    // 最后一个 `{` 之后到 `<ReviewDialog` 之间是它的渲染条件
    const condStart = guard.lastIndexOf('{')
    const condition = guard.slice(condStart)
    expect(condition).toContain('dialogOpen')
    // 不读 state（那正是「三态影响弹层挂载」的写法）
    expect(condition).not.toContain('state')
  })
})
