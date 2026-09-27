/**
 * 腾讯 provider 的模拟响应测试（#228）。
 *
 * 只用本地假上游：`Bun.serve` 起一个随机端口，把 provider 的 `endpoint` 指过去，
 * 按 `X-TC-Action` 分流文本/图片请求。真实腾讯调用需要授权环境，另行最小验证。
 *
 * 覆盖的是安全语义，不是实现细节：Suggestion → 统一决策、聚合取最高风险、
 * 失败一律**不放行**、有限重试次数、错误消息不搬运上游文本、Secret 不出现在请求体/错误里。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  createTencentContentModerationProvider,
  type TencentModerationConfig,
  type TencentModerationOptions,
} from './tencent'
import { ContentModerationError, type ModerationSuggestion, moderationErrorResponse } from './types'

const SECRET_ID = 'test-secret-id'
const SECRET_KEY = 'test-secret-key'
const TMS_BIZ_TYPE = 'tms-biz-type'
const IMS_BIZ_TYPE = 'ims-biz-type'
const TITLE = '八成新山地车'
const DESCRIPTION = '闲置转让，加微信详聊'
/** 上游回显的原文标记：任何错误消息里出现它就说明我们把上游文本搬出来了。 */
const UPSTREAM_ECHO = 'ECHO-上游原文-13800000000'

type MockCall = {
  action: string
  body: Record<string, unknown>
  headers: Headers
}

type MockUpstream = {
  endpoint: string
  calls: MockCall[]
  stop: () => void
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function tencentOk(extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    Response: {
      Suggestion: 'Pass',
      Label: 'Normal',
      SubLabel: '',
      Score: 0,
      RequestId: 'req-ok',
      ...extra,
    },
  })
}

/** 假上游：记录每个请求的 action / body / headers，响应由用例决定。 */
function startMockUpstream(
  handler: (call: MockCall) => Response | Promise<Response>,
): MockUpstream {
  const calls: MockCall[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const raw = await request.text()
      const call: MockCall = {
        action: request.headers.get('x-tc-action') ?? '',
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
        headers: request.headers,
      }
      calls.push(call)
      return await handler(call)
    },
  })
  return {
    endpoint: `127.0.0.1:${server.port}`,
    calls,
    stop: () => server.stop(true),
  }
}

const running: MockUpstream[] = []

afterEach(() => {
  while (running.length > 0) running.pop()?.stop()
})

function createProvider(
  upstream: MockUpstream,
  options: Partial<TencentModerationOptions> = {},
  config: Partial<TencentModerationConfig> = {},
) {
  running.push(upstream)
  return createTencentContentModerationProvider(
    {
      secretId: SECRET_ID,
      secretKey: SECRET_KEY,
      region: 'ap-guangzhou',
      tmsBizType: TMS_BIZ_TYPE,
      imsBizType: IMS_BIZ_TYPE,
      endpoint: upstream.endpoint,
      protocol: 'http:',
      ...config,
    },
    {
      loadImage: async () => ({ bytes: new Uint8Array([104, 105]) }),
      maxAttempts: 1,
      retryDelayMs: 0,
      ...options,
    },
  )
}

async function captureError(run: () => Promise<unknown>): Promise<ContentModerationError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ContentModerationError) return error
    throw error
  }
  throw new Error('预期调用失败，但成功返回了')
}

describe('腾讯 provider · 文本判定', () => {
  test('Suggestion=Pass → ALLOW，并回带 RequestId / Label / Score', async () => {
    const upstream = startMockUpstream(() =>
      tencentOk({ Label: 'Normal', Score: 7, RequestId: 'req-pass' }),
    )
    const provider = createProvider(upstream)

    const result = await provider.moderateText({
      dataId: 'lst_1',
      fields: [{ field: 'title', value: TITLE }],
    })

    expect(result.decision).toBe('ALLOW')
    expect(result.suggestion).toBe('Pass')
    expect(result.transport).toBe('tencent')
    expect(result.provider).toBe('TENCENT_TMS')
    expect(result.dataId).toBe('lst_1')
    expect(result.policyVersion).toBe(TMS_BIZ_TYPE)
    expect(result.fields).toHaveLength(1)
    expect(result.fields[0]).toMatchObject({
      field: 'title',
      decision: 'ALLOW',
      label: 'Normal',
      subLabel: null,
      score: 7,
      requestId: 'req-pass',
    })
    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]?.action).toBe('TextModeration')
  })

  test('RequestId 非白名单形状（换行/控制字符）→ 置 null，不把上游文本放进日志字段', async () => {
    const upstream = startMockUpstream(() =>
      tencentOk({ RequestId: 'req-ok\n[api] FAKE ADMIN LOGIN', Label: 'Normal' }),
    )
    const provider = createProvider(upstream)

    const result = await provider.moderateText({
      dataId: 'lst_9',
      fields: [{ field: 'title', value: TITLE }],
    })

    // 设计文档允许调用方把 RequestId 写进日志：它必须只能是白名单形状（上游不可信）。
    expect(result.decision).toBe('ALLOW')
    expect(result.fields[0]?.requestId).toBeNull()
  })

  test('Suggestion=Review / Block 分别映射为 REVIEW / BLOCK', async () => {
    const review = startMockUpstream(() => tencentOk({ Suggestion: 'Review', SubLabel: 'Ad' }))
    const blocked = startMockUpstream(() => tencentOk({ Suggestion: 'Block', Label: 'Illegal' }))

    const reviewResult = await createProvider(review).moderateText({
      dataId: 'lst_2',
      fields: [{ field: 'description', value: DESCRIPTION }],
    })
    const blockResult = await createProvider(blocked).moderateText({
      dataId: 'lst_3',
      fields: [{ field: 'title', value: TITLE }],
    })

    expect(reviewResult.decision).toBe('REVIEW')
    expect(reviewResult.fields[0]?.subLabel).toBe('Ad')
    expect(blockResult.decision).toBe('BLOCK')
    expect(blockResult.fields[0]?.label).toBe('Illegal')
  })

  test('多字段聚合取最高风险：title=Pass + description=Review → REVIEW；任一 Block → BLOCK', async () => {
    const byField: Record<string, ModerationSuggestion> = {
      'lst_4-title': 'Pass',
      'lst_4-description': 'Review',
      'lst_5-title': 'Pass',
      'lst_5-description': 'Block',
    }
    const upstream = startMockUpstream((call) =>
      tencentOk({ Suggestion: byField[String(call.body.DataId)] ?? 'Pass' }),
    )
    const provider = createProvider(upstream)

    const reviewed = await provider.moderateText({
      dataId: 'lst_4',
      fields: [
        { field: 'title', value: TITLE },
        { field: 'description', value: DESCRIPTION },
      ],
    })
    const blocked = await provider.moderateText({
      dataId: 'lst_5',
      fields: [
        { field: 'title', value: TITLE },
        { field: 'description', value: DESCRIPTION },
      ],
    })

    expect(reviewed.decision).toBe('REVIEW')
    expect(reviewed.suggestion).toBe('Review')
    expect(reviewed.fields.map((item) => item.decision)).toEqual(['ALLOW', 'REVIEW'])
    expect(blocked.decision).toBe('BLOCK')
    // DataId 按字段区分，便于在腾讯侧按字段定位：dataId-field。
    expect(upstream.calls.map((call) => call.body.DataId)).toEqual([
      'lst_4-title',
      'lst_4-description',
      'lst_5-title',
      'lst_5-description',
    ])
  })

  test('Content 是 base64 后的原文，请求不带 Secret', async () => {
    const upstream = startMockUpstream(() => tencentOk())
    const provider = createProvider(upstream)

    await provider.moderateText({ dataId: 'lst_6', fields: [{ field: 'title', value: TITLE }] })

    const call = upstream.calls[0]
    expect(call?.body.Content).toBe(Buffer.from(TITLE, 'utf8').toString('base64'))
    expect(call?.body.BizType).toBe(TMS_BIZ_TYPE)
    const serialized = JSON.stringify(call?.body)
    expect(serialized).not.toContain(SECRET_KEY)
    expect(call?.headers.get('authorization')).toContain(`Credential=${SECRET_ID}/`)
    expect(call?.headers.get('authorization')).not.toContain(SECRET_KEY)
  })

  test('全空白字段不算通过：不发请求，直接按入参错误拒绝', async () => {
    const upstream = startMockUpstream(() => tencentOk())
    const provider = createProvider(upstream)

    const error = await captureError(() =>
      provider.moderateText({ dataId: 'lst_7', fields: [{ field: 'title', value: '   ' }] }),
    )

    expect(error.reason).toBe('invalid_input')
    expect(error.detail).toBe('no_content')
    expect(error.retryable).toBe(false)
    expect(upstream.calls).toHaveLength(0)
  })

  test('dataId 越界（拼接字段后缀后 > 64 字符）→ 按入参错误拒绝，不发请求', async () => {
    const upstream = startMockUpstream(() => tencentOk())
    const provider = createProvider(upstream)

    const error = await captureError(() =>
      provider.moderateText({
        dataId: 'a'.repeat(60),
        fields: [{ field: 'title', value: TITLE }],
      }),
    )

    expect(error.reason).toBe('invalid_input')
    expect(error.detail).toBe('data_id')
    expect(upstream.calls).toHaveLength(0)
  })

  test('多字段里任一字段 dataId 越界都不发请求（不能先审一部分再报入参错误）', async () => {
    const upstream = startMockUpstream(() => tencentOk())
    const provider = createProvider(upstream)

    // `-title` 后缀（6 字符）仍合法，`-description`（12 字符）越界：如果逐字段边拼边校验，
    // title 已经真实调到腾讯（计费并产生审核记录），调用方却拿不到它的判定。
    const error = await captureError(() =>
      provider.moderateText({
        dataId: 'a'.repeat(56),
        fields: [
          { field: 'title', value: TITLE },
          { field: 'description', value: DESCRIPTION },
        ],
      }),
    )

    expect(error.reason).toBe('invalid_input')
    expect(error.detail).toBe('data_id')
    expect(upstream.calls).toHaveLength(0)
  })
})

describe('腾讯 provider · 失败与重试（一律不放行）', () => {
  test('HTTP 5xx：按 maxAttempts 重试后失败，错误里没有上游文本', async () => {
    const upstream = startMockUpstream(() => new Response(`${UPSTREAM_ECHO}`, { status: 502 }))
    const provider = createProvider(upstream, { maxAttempts: 3 })

    const error = await captureError(() =>
      provider.moderateText({ dataId: 'lst_8', fields: [{ field: 'title', value: TITLE }] }),
    )

    expect(upstream.calls).toHaveLength(3)
    expect(error.reason).toBe('upstream_error')
    expect(error.retryable).toBe(true)
    expect(error.httpCode).toBe(502)
    expect(error.message).not.toContain(UPSTREAM_ECHO)
    expect(error.message).not.toContain('微信')
    expect(error.message).not.toContain(SECRET_KEY)
    expect(moderationErrorResponse(error)).toEqual({
      status: 503,
      code: 'CONTENT_MODERATION_UNAVAILABLE',
    })
  })

  test('HTTP 429 → throttled（重试）；HTTP 403 → configuration（不重试）', async () => {
    const throttled = startMockUpstream(() => new Response('slow down', { status: 429 }))
    const unauthenticated = startMockUpstream(() => new Response('forbidden', { status: 403 }))

    const throttledError = await captureError(() =>
      createProvider(throttled, { maxAttempts: 2 }).moderateText({
        dataId: 'lst_9',
        fields: [{ field: 'title', value: TITLE }],
      }),
    )
    const configError = await captureError(() =>
      createProvider(unauthenticated, { maxAttempts: 3 }).moderateText({
        dataId: 'lst_10',
        fields: [{ field: 'title', value: TITLE }],
      }),
    )

    expect(throttled.calls).toHaveLength(2)
    expect(throttledError.reason).toBe('throttled')
    expect(throttledError.retryable).toBe(true)
    // 凭据/权限错了重试没有意义：只发一次。
    expect(unauthenticated.calls).toHaveLength(1)
    expect(configError.reason).toBe('configuration')
    expect(configError.retryable).toBe(false)
  })

  test('200 但 Response.Error：按 Error.Code 归类，且不搬运 Error.Message / RequestId 之外的字段', async () => {
    const upstream = startMockUpstream(() =>
      jsonResponse({
        Response: {
          Error: { Code: 'RequestLimitExceeded', Message: UPSTREAM_ECHO },
          RequestId: 'req-limit',
        },
      }),
    )
    const provider = createProvider(upstream, { maxAttempts: 1 })

    const error = await captureError(() =>
      provider.moderateText({ dataId: 'lst_11', fields: [{ field: 'title', value: TITLE }] }),
    )

    expect(error.reason).toBe('throttled')
    expect(error.upstreamCode).toBe('RequestLimitExceeded')
    expect(error.requestId).toBe('req-limit')
    expect(error.message).toContain('code=RequestLimitExceeded')
    expect(error.message).not.toContain(UPSTREAM_ECHO)
  })

  test('200 但响应体不是 JSON → invalid_response（重试），不放行', async () => {
    const upstream = startMockUpstream(() => new Response('<html>gateway</html>'))
    const provider = createProvider(upstream, { maxAttempts: 2 })

    const error = await captureError(() =>
      provider.moderateText({ dataId: 'lst_12', fields: [{ field: 'title', value: TITLE }] }),
    )

    expect(upstream.calls).toHaveLength(2)
    expect(error.reason).toBe('invalid_response')
    expect(error.detail).toBe('payload')
  })

  test('200 但 Response 不是对象 → invalid_response（重试），不漏出裸 TypeError', async () => {
    // SDK 的 parseResponse 只要求 data.Response 为真值：字符串会原样返回给调用方。
    const upstream = startMockUpstream(() => jsonResponse({ Response: 'gateway-ok' }))
    const provider = createProvider(upstream, { maxAttempts: 2 })

    const error = await captureError(() =>
      provider.moderateText({ dataId: 'lst_16', fields: [{ field: 'title', value: TITLE }] }),
    )

    expect(upstream.calls).toHaveLength(2)
    expect(error.reason).toBe('invalid_response')
    expect(error.detail).toBe('payload')
    expect(error.retryable).toBe(true)
  })

  test('Suggestion 缺失或非枚举值 → invalid_response，不默认 ALLOW', async () => {
    const missing = startMockUpstream(() => jsonResponse({ Response: { RequestId: 'req-x' } }))
    const unknown = startMockUpstream(() => tencentOk({ Suggestion: 'Unknown' }))

    const missingError = await captureError(() =>
      createProvider(missing, { maxAttempts: 1 }).moderateText({
        dataId: 'lst_13',
        fields: [{ field: 'title', value: TITLE }],
      }),
    )
    const unknownError = await captureError(() =>
      createProvider(unknown, { maxAttempts: 1 }).moderateText({
        dataId: 'lst_14',
        fields: [{ field: 'title', value: TITLE }],
      }),
    )

    expect(missingError.reason).toBe('invalid_response')
    expect(missingError.detail).toBe('suggestion')
    expect(unknownError.reason).toBe('invalid_response')
    expect(unknownError.detail).toBe('suggestion')
  })

  test('连不上上游 → network（可重试），仍不放行', async () => {
    const upstream: MockUpstream = {
      endpoint: '127.0.0.1:1',
      calls: [],
      stop: () => {},
    }
    const provider = createProvider(upstream, { maxAttempts: 2 })

    const error = await captureError(() =>
      provider.moderateText({ dataId: 'lst_15', fields: [{ field: 'title', value: TITLE }] }),
    )

    expect(error.reason).toBe('network')
    expect(error.retryable).toBe(true)
  })

  test('上游不响应：传输超时归类为 timeout（可重试），不返回 ALLOW', async () => {
    const hanging = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    const upstream: MockUpstream = {
      endpoint: `127.0.0.1:${hanging.port}`,
      calls: [],
      stop: () => hanging.stop(true),
    }
    const provider = createProvider(
      upstream,
      { maxAttempts: 1, retryDelayMs: 0 },
      { timeoutMs: 1000 },
    )

    const error = await captureError(() =>
      provider.moderateText({ dataId: 'lst_16', fields: [{ field: 'title', value: TITLE }] }),
    )

    expect(error.reason).toBe('timeout')
    expect(error.retryable).toBe(true)
    expect(error.message).not.toContain(UPSTREAM_ECHO)
  }, 20_000)
})

describe('腾讯 provider · 图片判定', () => {
  test('IMS Pass → ALLOW，并回带 FileMD5 作为 contentDigest', async () => {
    const upstream = startMockUpstream((call) =>
      call.action === 'ImageModeration'
        ? tencentOk({
            FileMD5: 'd41d8cd98f00b204e9800998ecf8427e',
            Suggestion: 'Pass',
            Label: 'Normal',
          })
        : tencentOk(),
    )
    const provider = createProvider(upstream, {}, {})

    const result = await provider.moderateImage({ dataId: 'img_1', objectKey: 'listings/a.jpg' })

    expect(result.decision).toBe('ALLOW')
    expect(result.provider).toBe('TENCENT_IMS')
    expect(result.objectKey).toBe('listings/a.jpg')
    expect(result.contentDigest).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(result.policyVersion).toBe(IMS_BIZ_TYPE)
    expect(result.reasonCode).toBeNull()
    expect(upstream.calls[0]?.action).toBe('ImageModeration')
    expect(upstream.calls[0]?.body.FileContent).toBe(
      Buffer.from(new Uint8Array([104, 105])).toString('base64'),
    )
    expect(upstream.calls[0]?.body.BizType).toBe(IMS_BIZ_TYPE)
  })

  test('IMS Block → BLOCK；Review → REVIEW', async () => {
    const blocked = startMockUpstream(() => tencentOk({ Suggestion: 'Block', Label: 'Porn' }))
    const reviewed = startMockUpstream(() => tencentOk({ Suggestion: 'Review' }))

    const blockResult = await createProvider(blocked).moderateImage({
      dataId: 'img_2',
      objectKey: 'listings/b.jpg',
    })
    const reviewResult = await createProvider(reviewed).moderateImage({
      dataId: 'img_3',
      objectKey: 'listings/c.jpg',
    })

    expect(blockResult.decision).toBe('BLOCK')
    expect(reviewResult.decision).toBe('REVIEW')
    expect(reviewResult.subLabel).toBeNull()
    // 上游没回 FileMD5：摘要为 null（调用方不得把 null 当通过），而不是编造一个。
    expect(blockResult.contentDigest).toBeNull()
  })

  test('FileMD5 大小写不同 → 统一小写（同一图片的摘要不该假不等）', async () => {
    const upstream = startMockUpstream(() =>
      tencentOk({ FileMD5: 'D41D8CD98F00B204E9800998ECF8427E', Suggestion: 'Pass' }),
    )

    const result = await createProvider(upstream).moderateImage({
      dataId: 'img_8',
      objectKey: 'listings/h.jpg',
    })

    expect(result.contentDigest).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })

  test('FileMD5 非 MD5 形状 → invalid_response（不放行），不把任意字符串当摘要', async () => {
    const upstream = startMockUpstream(() =>
      tencentOk({ FileMD5: 'ok\n[api] FAKE ADMIN LOGIN', Suggestion: 'Pass' }),
    )
    running.push(upstream)
    const provider = createProvider(upstream, { maxAttempts: 2, retryDelayMs: 0 }, {})

    const error = await captureError(() =>
      provider.moderateImage({ dataId: 'img_9', objectKey: 'listings/i.jpg' }),
    )

    // 摘要是后续「图片未被替换」的证明：形状不对说明上游响应不可信，按可重试的
    // invalid_response 失败，绝不把任意字符串透传给调用方当证明。
    expect(error.reason).toBe('invalid_response')
    expect(error.provider).toBe('TENCENT_IMS')
    expect(error.detail).toBe('digest')
    expect(error.retryable).toBe(true)
    expect(moderationErrorResponse(error)).toEqual({
      status: 503,
      code: 'CONTENT_MODERATION_UNAVAILABLE',
    })
    expect(upstream.calls).toHaveLength(2)
    expect(error.message).not.toContain('FAKE ADMIN LOGIN')
  })

  test('对象不存在 / 图片过大 / dataId 越界 → invalid_input，不发请求', async () => {
    const upstream = startMockUpstream(() => tencentOk())
    running.push(upstream)
    const config: TencentModerationConfig = {
      secretId: SECRET_ID,
      secretKey: SECRET_KEY,
      region: 'ap-guangzhou',
      tmsBizType: TMS_BIZ_TYPE,
      imsBizType: IMS_BIZ_TYPE,
      endpoint: upstream.endpoint,
      protocol: 'http:',
    }

    const missing = createTencentContentModerationProvider(config, {
      loadImage: async () => null,
      maxAttempts: 1,
    })
    const tooLarge = createTencentContentModerationProvider(config, {
      loadImage: async () => ({ bytes: new Uint8Array(7_500_001) }),
      maxAttempts: 1,
    })
    const provider = createTencentContentModerationProvider(config, {
      loadImage: async () => ({ bytes: new Uint8Array([104, 105]) }),
      maxAttempts: 1,
    })

    const missingError = await captureError(() =>
      missing.moderateImage({ dataId: 'img_4', objectKey: 'listings/missing.jpg' }),
    )
    const largeError = await captureError(() =>
      tooLarge.moderateImage({ dataId: 'img_5', objectKey: 'listings/large.jpg' }),
    )
    const dataIdError = await captureError(() =>
      provider.moderateImage({ dataId: 'a'.repeat(65), objectKey: 'listings/d.jpg' }),
    )

    expect(missingError.reason).toBe('invalid_input')
    expect(missingError.detail).toBe('image_missing')
    expect(largeError.reason).toBe('invalid_input')
    expect(largeError.detail).toBe('image_too_large')
    expect(dataIdError.reason).toBe('invalid_input')
    expect(dataIdError.detail).toBe('data_id')
    expect(moderationErrorResponse(missingError)).toEqual({
      status: 400,
      code: 'CONTENT_MODERATION_INVALID_INPUT',
    })
    expect(upstream.calls).toHaveLength(0)
  })

  test('图片重试：读取只发生一次，IMS 请求按 maxAttempts 重放', async () => {
    const upstream = startMockUpstream(() => new Response('boom', { status: 500 }))
    running.push(upstream)
    let reads = 0
    const provider = createTencentContentModerationProvider(
      {
        secretId: SECRET_ID,
        secretKey: SECRET_KEY,
        region: 'ap-guangzhou',
        tmsBizType: TMS_BIZ_TYPE,
        imsBizType: IMS_BIZ_TYPE,
        endpoint: upstream.endpoint,
        protocol: 'http:',
      },
      {
        loadImage: async () => {
          reads += 1
          return { bytes: new Uint8Array([104, 105]) }
        },
        maxAttempts: 3,
        retryDelayMs: 0,
      },
    )

    const error = await captureError(() =>
      provider.moderateImage({ dataId: 'img_6', objectKey: 'listings/e.jpg' }),
    )

    expect(reads).toBe(1)
    expect(upstream.calls).toHaveLength(3)
    expect(error.reason).toBe('upstream_error')
    expect(error.provider).toBe('TENCENT_IMS')
  })

  test('读取对象失败（存储异常）→ 统一按 network 失败，不漏出裸异常', async () => {
    const upstream = startMockUpstream(() => tencentOk())
    running.push(upstream)
    const storageMessage = `S3 503 bucket=fish-secret ${UPSTREAM_ECHO}`
    const provider = createTencentContentModerationProvider(
      {
        secretId: SECRET_ID,
        secretKey: SECRET_KEY,
        region: 'ap-guangzhou',
        tmsBizType: TMS_BIZ_TYPE,
        imsBizType: IMS_BIZ_TYPE,
        endpoint: upstream.endpoint,
        protocol: 'http:',
      },
      {
        loadImage: async () => {
          throw new Error(storageMessage)
        },
        maxAttempts: 1,
        retryDelayMs: 0,
      },
    )

    const error = await captureError(() =>
      provider.moderateImage({ dataId: 'img_7', objectKey: 'listings/f.jpg' }),
    )

    // 读取失败也是审核失败：调用方要能按统一错误映射成 503，而不是落到框架 500。
    expect(error.reason).toBe('network')
    expect(error.provider).toBe('TENCENT_IMS')
    expect(error.detail).toBe('image_load')
    expect(error.retryable).toBe(true)
    expect(moderationErrorResponse(error)).toEqual({
      status: 503,
      code: 'CONTENT_MODERATION_UNAVAILABLE',
    })
    // 存储异常文本（可能含 bucket / 对象路径 / 用户原文）不回带。
    expect(error.message).not.toContain('fish-secret')
    expect(error.message).not.toContain(UPSTREAM_ECHO)
    expect(upstream.calls).toHaveLength(0)
  })
})
