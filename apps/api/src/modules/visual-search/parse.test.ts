import { afterEach, describe, expect, test } from 'bun:test'
import type { VisualInterpretation, VisualSubjectBox } from '@fish/contracts/visual/schema'
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
async function parseWith(content: unknown): Promise<{
  interpretation: VisualInterpretation | null
  subjectBox: VisualSubjectBox | null
  requests: string[]
}> {
  const requests = stubChatCompletion(content)
  const result = await createVisualParser(ENV).parse(IMAGE_BYTES, 'image/png')
  return { ...result, requests }
}

/** 收集一段代码执行期间的 `console.warn`。 */
async function captureWarnings(run: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    await run()
  } finally {
    console.warn = originalWarn
  }
  return warnings
}

test('思考型解析模型的 token 预算同时容纳思考与最终主体 JSON', async () => {
  let budget = 0
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { max_tokens: number }
    budget = body.max_tokens
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            reasoning_content: 'synthetic reasoning',
            content: '{"keywords":["红色圆形"],"subject":[583,375,750,625]}',
          },
        },
      ],
    })
  }) as typeof fetch
  const result = await createVisualParser({ ...ENV, model: 'deepseek-flash' }).parse(
    IMAGE_BYTES,
    'image/png',
  )
  // 真实服务的 512 预算被思考消耗，finish_reason=length，仅剩截断 JSON；2048 实测完整返回。
  expect(budget).toBe(2048)
  expect(result.subjectBox?.x).toBe(0.583)
})

describe('createVisualParser 的主体框（#584）', () => {
  test('0–1000 归一化的 [x1, y1, x2, y2] 换算成图宽高的比例，其余字段照常解析', async () => {
    const { interpretation, subjectBox } = await parseWith({
      text: 'EPSON GD-420S',
      category: 'DIGITAL',
      subject: [250, 100, 750, 900],
    })

    expect(subjectBox).toEqual({ x: 0.25, y: 0.1, width: 0.5, height: 0.8 })
    // subject 不属于 interpretation 契约：剥掉后其余字段仍按 strictObject 校验通过。
    expect(interpretation).toEqual({ text: 'EPSON GD-420S', category: 'DIGITAL' })
  })

  test('越出 0–1000 的坐标夹回图内', async () => {
    const { subjectBox } = await parseWith({ subject: [-20, 500, 1100, 1000] })

    expect(subjectBox).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 })
  })

  test('只有主体框、没有文字信号时：框照给，interpretation 为 null', async () => {
    const { interpretation, subjectBox } = await parseWith({ subject: [0, 0, 500, 500] })

    expect(interpretation).toBeNull()
    expect(subjectBox).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 })
  })

  test('interpretation 形状不符整段拒绝时，主体框不受牵连', async () => {
    const { interpretation, subjectBox } = await parseWith({
      text: 42,
      subject: [0, 0, 1000, 1000],
    })

    expect(interpretation).toBeNull()
    expect(subjectBox).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  test('不是 4 个有限数字 / 面积为零的框按无主体处理，并各留一条日志', async () => {
    for (const subject of [[1, 2, 3], ['0', 0, 10, 10], [0, 0, Number.NaN, 10], { x: 0 }]) {
      const warnings = await captureWarnings(async () => {
        const { subjectBox, interpretation } = await parseWith({ category: 'BOOKS', subject })
        expect(subjectBox).toBeNull()
        expect(interpretation).toEqual({ category: 'BOOKS' })
      })
      expect(warnings.some((line) => line.includes('subject 不是 4 个数字'))).toBe(true)
    }

    const warnings = await captureWarnings(async () => {
      const { subjectBox } = await parseWith({ subject: [600, 100, 400, 900] })
      expect(subjectBox).toBeNull()
    })
    expect(warnings.some((line) => line.includes('subject 面积为零'))).toBe(true)
  })

  test('省略 subject 或回 null 时没有框，也不留日志', async () => {
    for (const payload of [{ category: 'BOOKS' }, { category: 'BOOKS', subject: null }]) {
      const warnings = await captureWarnings(async () => {
        const { subjectBox, interpretation } = await parseWith(payload)
        expect(subjectBox).toBeNull()
        expect(interpretation).toEqual({ category: 'BOOKS' })
      })
      expect(warnings).toEqual([])
    }
  })
})

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

  test('数组项全被丢弃且没有其它字段时整体判失败（不是返回空对象）', async () => {
    // 归一化前 `text: [null, 42]` 会整段校验失败 → `null`；归一化后必须保持同一个结果，
    // 否则响应里的 `interpretation` 会从 `null` 变成一个字段全空的 `{}`（客户端可见的行为变化）。
    const { interpretation } = await parseWith({ text: [null, 42] })

    expect(interpretation).toBeNull()
  })

  test('丢弃数组项时留一条只说条数的日志（可与"图里没有文字"区分）', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '))
    }
    try {
      await parseWith({ text: ['EPSON', null, '   ', 'GD-420S'], category: 'DIGITAL' })
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toHaveLength(1)
    // 只说条数：日志里不得出现识别出的文字内容（那是用户上传图片里的内容）。
    expect(warnings[0]).toContain('丢弃 2/4 项')
    expect(warnings[0]).not.toContain('EPSON')
  })
})
