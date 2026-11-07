import { describe, expect, test } from 'bun:test'

/**
 * 出物结果卡的**宽窗口上限**（#632）。
 *
 * `max-width` 这条上限只有写成**大写 `PX`** 才成立：pxtransform（`designWidth: 750`）会把小写
 * `600px` 编译成 `600rpx`，也就是「窗口宽的 80%」——在 PC 微信 / iPad 上继续随窗口放大，等于
 * 没有上限。而它长得就像个笔误：Biome 的格式化会直接把单位改回小写、编辑器「规范化」也会，
 * 改完 WXSS 里照样有 `max-width`，CI 全绿，只是需求静默失效。所以这里把两条不变量钉住：
 *
 * 1. `max-width` 的单位必须是原样的大写 `PX`；
 * 2. 上限数值必须与同一规则里的小写 `width` 一致（那条会被编译成 rpx，是手机上的设计宽）。
 *
 * 另钉一条配套约束：卡被钉成物理宽后，内部字号/内边距仍是 rpx，窗口很宽时文案会顶出卡片，
 * 因此主钮必须允许换行（`white-space: normal`）。
 *
 * 期望值全部从 SCSS 自身解析出来，不写死 600：改设计宽度时只改 SCSS，测试跟着走；只有
 * 「单位大小写」「上限与设计宽一致」「主钮可换行」这三件事变了才会红。
 */

async function scss(): Promise<string> {
  return await Bun.file(new URL('../src/pages/sell/index.scss', import.meta.url)).text()
}

/** 取某个选择器的规则体（这些规则内部没有嵌套块，按首个 `}` 截断即可） */
async function ruleBody(selector: string): Promise<string> {
  const source = await scss()
  const start = source.indexOf(`${selector} {`)
  expect(start, `index.scss 里找不到 ${selector} 规则`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n}', start)
  expect(end, `${selector} 规则没有闭合`).toBeGreaterThan(start)
  // 先剥注释再解析：这些规则的注释里就写着 `white-space: nowrap` / `600rpx` 这类字样，
  // 不剥的话「声明被删、注释还在」会让断言假绿。
  return source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
}

function declaration(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`).exec(body)?.[1].trim()
}

describe('出物结果卡宽窗口上限（#632）', () => {
  test('max-width 用大写 PX，数值与设计宽一致', async () => {
    const body = await ruleBody('.sell__result')
    const design = declaration(body, 'width')
    const cap = declaration(body, 'max-width')

    expect(design, '.sell__result 缺少 width（手机端设计宽，会被编译成 rpx）').toBeDefined()
    expect(cap, '结果卡缺少宽窗口上限 max-width').toBeDefined()

    // 小写 px 会被 pxtransform 编译成 rpx = 窗口宽的百分比，上限失效
    expect(
      cap,
      `max-width: ${cap} —— 单位必须写成大写 PX，小写 px 会被编译成 rpx，等于没有上限`,
    ).toMatch(/^\d+(?:\.\d+)?PX$/)
    expect(Number.parseFloat(cap as string), '上限应与设计宽同值').toBe(
      Number.parseFloat(design as string),
    )
  })

  test('主钮允许换行，越界文案撑高而非画出卡片', async () => {
    const body = await ruleBody('.sell__result .sell__submit')
    // 基类 `.sell__submit` 是 white-space: nowrap，卡内不放开就会在 W≈1100px 以上顶出卡片
    expect(
      declaration(body, 'white-space'),
      '主钮需要 white-space: normal 兜住宽窗口下的文案溢出',
    ).toBe('normal')
  })

  test('次钮高度是下限而非固定值，折行时自己长高', async () => {
    const body = await ruleBody('.sell__result .sell__btn-line')
    // 基类 `.sell__btn-line` 是固定 height，卡内折行时文字会越过胶囊下沿
    expect(declaration(body, 'height'), '次钮需要 height: auto').toBe('auto')
    expect(
      declaration(body, 'min-height'),
      '次钮需要 min-height: var(--btn-h-lg) 保住档位高度',
    ).toBe('var(--btn-h-lg)')
  })
})
