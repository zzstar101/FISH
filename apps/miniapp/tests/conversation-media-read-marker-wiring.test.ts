import { describe, expect, test } from 'bun:test'

/**
 * 媒体消息（图片 / 语音）的逐条读位接线（2026-11-10）。
 *
 * 缺陷：`.conv__rd`（已读 / 未读）原先只有文本气泡那条分支渲染，`entry.kind === 'media'`
 * 分支的时间行只有时间戳，所以**自己发的图片和语音从来不说对方读没读** —— 文本消息有读位、
 * 图片没有，同一条会话里两套口径。
 *
 * 本仓 `apps/miniapp/tests/` 没有 Taro 组件渲染基建（页面用真 `@tarojs/taro` 加载会抛
 * `ENABLE_INNER_HTML is not defined`，见 `tests/conversation-unread-wiring.test.ts` 文件头），
 * 端上肉眼可见的结果只能在微信开发者工具里验；这里钉住容易被改回去的结构：
 * - 媒体分支必须用**同一个** `messageReadLabel` 判据（不得自判一套，否则两处口径迟早漂移）；
 * - 判据结果必须真的渲染到媒体行的时间后面，且「未读」才挂 `is-unread`；
 * - 待发（`pending-media`）没有读位 —— 消息还没发出去，读不读无从谈起。
 *
 * 判据本身（何时算已读、解析失败算未读、非我发的返回 null）由 `tests/conversation-read-marker.test.ts`
 * 与 `tests/conversation-view.test.ts` 覆盖，这里只管页面接线。
 */

async function source(): Promise<string> {
  return Bun.file(new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

/** 剥掉注释再断言：注释里抄一份同名语句不能冒充接线（仓库既有写法，见 back-top-scroll-source.test.ts） */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 已读 / 未读的样式类判据，文本分支与媒体分支必须完全一致 */
const RD_CLASS = 'conv__rd${'

describe('媒体消息读位 · 接线', () => {
  test('媒体分支复用 messageReadLabel，并把三个入参与文本分支对齐', async () => {
    const code = stripComments(await source())
    const media = sliceFrom(
      code,
      "if (entry.kind === 'media') {",
      "if (entry.kind === 'pending-media')",
    )

    expect(media).toContain('const mediaReadLabel = messageReadLabel({')
    // 三个入参一个都不能少：少了 mine 会把对方发来的图也标上读位，
    // 少了 counterpartLastReadAt 则永远算未读（正是这个缺陷的「已读信息缺失」表现）
    // 入参断言必须落在**调用块内部**：媒体切片里别处本来就有裸 `mine,`
    // （`renderVoiceBubble(item.id, item.durationMs, mine, …)`），只查 `toContain('mine,')`
    // 是空断言 —— 把 `mine` 从 `messageReadLabel({…})` 删掉照样通过。
    const call = sliceFrom(media, 'const mediaReadLabel = messageReadLabel({', '})')
    expect(call).toMatch(/messageReadLabel\(\{\s*mine,/)
    expect(call).toContain('createdAt: item.createdAt,')
    expect(call).toContain('counterpartLastReadAt: conversation.counterpartLastReadAt,')
  })

  test('读位渲染在媒体行时间后面，只有「未读」挂 is-unread', async () => {
    const code = stripComments(await source())
    const media = sliceFrom(
      code,
      "if (entry.kind === 'media') {",
      "if (entry.kind === 'pending-media')",
    )

    // 只算不渲染 = 端上照样看不到，必须真的进 JSX
    expect(media).toContain('{mediaReadLabel ? (')
    expect(media).toContain(`${RD_CLASS}mediaReadLabel === '未读' ? ' is-unread' : ''}\`}`)
    expect(media).toMatch(/\{` · \$\{mediaReadLabel\}`\}/)
    // 撤回碑那条 `conv__time` 保持原样：撤回后没有可读性语义，别给它套读位
    const recalled = sliceFrom(media, 'if (item.recalledAt !== null) {', 'const local =')
    expect(recalled).not.toContain('mediaReadLabel')
  })

  test('待发媒体（pending-media）不渲染读位：消息还没发出去', async () => {
    const code = stripComments(await source())
    const pending = sliceFrom(
      code,
      "if (entry.kind === 'pending-media') {",
      'const message = entry.message',
    )

    expect(pending).toContain('canRetryMedia(item)')
    expect(pending).not.toContain('messageReadLabel')
    expect(pending).not.toContain(RD_CLASS)
  })

  test('文本分支与媒体分支共用同一套读位类名判据', async () => {
    const code = stripComments(await source())
    // 两处都必须按「未读 → is-unread」这一条映射，任一处自判就成了两套口径。
    // 按 slice 分别断言各 1 处，而不是全文计数：将来出现**合法**的第三处读位
    // （例如给商品卡补读位）不该无故变红，这里只需钉住两个分支各自沿用同一条映射。
    const media = sliceFrom(
      code,
      "if (entry.kind === 'media') {",
      "if (entry.kind === 'pending-media')",
    )
    const text = sliceFrom(code, 'const readLabel = messageReadLabel({', `\` · \${readLabel}\`}`)
    const marksIn = (slice: string) =>
      slice.match(/conv__rd\$\{[^}]*=== '未读' \? ' is-unread' : ''\}/g) ?? []
    expect(marksIn(media)).toHaveLength(1)
    expect(marksIn(text)).toHaveLength(1)
  })
})
