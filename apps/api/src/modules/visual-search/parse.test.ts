import { afterEach, describe, expect, test } from 'bun:test'
import type { VisualInterpretation } from '@fish/contracts/visual/schema'
import type { VisualParseEnv } from '@fish/shared/env'
import { createVisualParser, visualTextQueryOf } from './parse'

/**
 * 语义解析（#324 M5）的**上游包装差异**回归：不出网，用假 fetch 喂上游真实回过的形状。
 *
 * 钉的是 #406 第 1 项：百炼 `qwen3-vl-plus` 在 `response_format: json_object` 下会把 `text`
 * 回成字符串**数组**，而契约里它是单个字符串——此前整段 interpretation 校验失败、
 * 文本路静默跳过，用户看到的是"这个类目没有行情"而不是"解析失败"。
 *
 * 同时钉住**不能被放宽**的那一半：真正的形状不符（`text` 是数字、多出未知字段）
 * 必须照样整段拒绝。否则"容错"会退化成"什么都收"，契约就不再是契约了。
 */
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const ENV: VisualParseEnv = {
  transport: 'live',
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-not-a-real-key',
  model: 'qwen3-vl-plus',
}

const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71])

/**
 * 假 fetch：把给定内容包成一次 `chat/completions` 响应，并记录请求 URL。
 * 每次调用都重新装一遍——`afterEach` 会把它还原成真 fetch，漏装就会变成"真的出网"。
 */
function stubChatCompletion(content: unknown): string[] {
  const requests: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    )
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return requests
}

/** 装上假 fetch 后解析一次，返回解析结果与（已断言的）请求 URL 列表。 */
async function parseWith(
  content: unknown,
): Promise<{ interpretation: VisualInterpretation | null; requests: string[] }> {
  const requests = stubChatCompletion(content)
  const interpretation = await createVisualParser(ENV).parse(IMAGE_BYTES, 'image/png')
  return { interpretation, requests }
}

describe('createVisualParser 的解析结果归一', () => {
  test('text 是字符串数组（百炼实测形状）时仍解析成功，并归一成一个查询串', async () => {
    const { interpretation, requests } = await parseWith({
      text: ['EPSON', 'GD-420S', 'MADE IN TAIWAN'],
      category: 'DIGITAL',
    })

    expect(requests).toEqual(['https://api.example.com/v1/chat/completions'])
    expect(interpretation?.text).toBe('EPSON GD-420S MADE IN TAIWAN')
    expect(interpretation?.category).toBe('DIGITAL')
    // 归一后的文本必须真的进得了文本路查询（这是修复的用户可见后果）。
    expect(visualTextQueryOf(interpretation)).toContain('GD-420S')
  })

  test('数组里的非字符串项与空白项被丢弃', async () => {
    const { interpretation } = await parseWith({
      text: ['  EPSON  ', null, 42, 'GD-420S', '   '],
    })

    expect(interpretation?.text).toBe('EPSON GD-420S')
  })

  test('数组全是空白项时 text 整体缺席，其余字段照常保留', async () => {
    const { interpretation } = await parseWith({ text: ['', '   '], category: 'BOOKS' })

    expect(interpretation?.category).toBe('BOOKS')
    if (!interpretation) throw new Error('解析应当成功')
    expect('text' in interpretation).toBe(false)
  })

  test('text 是数字这类真正的形状不符仍然整段拒绝（没有放宽契约）', async () => {
    const { interpretation } = await parseWith({ text: 42, category: 'BOOKS' })

    expect(interpretation).toBeNull()
  })

  test('多出未知字段仍然整段拒绝（strictObject 的纪律不变）', async () => {
    const { interpretation } = await parseWith({ text: 'EPSON GD-420S', soldPriceCents: 123 })

    expect(interpretation).toBeNull()
  })
})
