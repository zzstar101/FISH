/**
 * 真实审核上游探针（#228）：拿到授权测试环境后，做一次最小真实调用。
 *
 * 用途：验证凭据 / BizType / 地域 / 网络是否真的可用，并看清腾讯返回的判定与 `RequestId`。
 * 本脚本**不打印原文与图片字节**，只打印判定、`RequestId` 与耗时——日志里不出现用户文本是服务端红线。
 *
 * 用法（配置留在 .env 里，不落命令行）：
 *   bun --env-file=.env apps/api/scripts/moderation-live-probe.ts '八成新山地车，校内自提' [可选图片路径]
 *
 * - 第一个参数是待审文本（不给则用内置构造样例）。
 * - 第二个参数是待审图片路径；探针把路径当作 `objectKey` 直接读文件，不做任何存储接线。
 * - 前置：`CONTENT_MODERATION_TRANSPORT=tencent` + 四项腾讯配置齐全，否则本脚本直接拒绝运行
 *   （`local` 是本机词表，探它没有意义）。
 * - 每次调用都是真实计费请求；不要喂真实用户内容，用构造样例即可。
 */

import { loadContentModerationEnv } from '@fish/shared/env'
import {
  createTencentContentModerationProvider,
  type ModerationImageSource,
} from '../src/modules/moderation/providers/tencent'
import { ContentModerationError } from '../src/modules/moderation/providers/types'

const DEFAULT_TEXT = '八成新山地车，自用一学期，校内自提，可小刀'
const SAMPLE_IMAGE_PATH = '（未提供，跳过图片审核）'

function formatError(error: unknown): string {
  if (error instanceof ContentModerationError) {
    const parts = [`reason=${error.reason}`, `retryable=${error.retryable}`]
    if (error.provider) parts.push(`provider=${error.provider}`)
    if (error.httpCode !== null) parts.push(`httpCode=${error.httpCode}`)
    if (error.upstreamCode) parts.push(`code=${error.upstreamCode}`)
    if (error.requestId) parts.push(`requestId=${error.requestId}`)
    if (error.detail) parts.push(`detail=${error.detail}`)
    return parts.join(' ')
  }
  return error instanceof Error ? error.name : typeof error
}

const args = Bun.argv.slice(2)
const text = args[0] ?? DEFAULT_TEXT
const imagePath = args[1]

const env = loadContentModerationEnv()
if (env.transport !== 'tencent') {
  console.error(
    '[moderation-probe] 需要 CONTENT_MODERATION_TRANSPORT=tencent（local 是本机词表，探它没有意义）',
  )
  process.exit(2)
}

const provider = createTencentContentModerationProvider(
  {
    secretId: env.secretId,
    secretKey: env.secretKey,
    region: env.region,
    tmsBizType: env.tmsBizType,
    imsBizType: env.imsBizType,
  },
  {
    loadImage: async (objectKey): Promise<ModerationImageSource | null> => {
      const file = Bun.file(objectKey)
      if (!(await file.exists())) return null
      return { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type }
    },
  },
)

console.log(`[moderation-probe] region=${env.region} tms=${env.tmsBizType} ims=${env.imsBizType}`)

let failed = false

const textStarted = performance.now()
try {
  const result = await provider.moderateText({
    dataId: 'probe-text',
    fields: [
      { field: 'title', value: text },
      { field: 'description', value: text },
    ],
  })
  console.log(
    `[文本] decision=${result.decision} suggestion=${result.suggestion} policyVersion=${result.policyVersion} ` +
      `latency=${Math.round(performance.now() - textStarted)}ms`,
  )
  for (const field of result.fields) {
    console.log(
      `  - ${field.field}: decision=${field.decision} label=${field.label ?? '-'} ` +
        `subLabel=${field.subLabel ?? '-'} score=${field.score ?? '-'} requestId=${field.requestId ?? '-'}`,
    )
  }
} catch (error) {
  failed = true
  console.error(`[文本] 失败：${formatError(error)}`)
}

if (imagePath) {
  const imageStarted = performance.now()
  try {
    const result = await provider.moderateImage({ dataId: 'probe-image', objectKey: imagePath })
    console.log(
      `[图片] decision=${result.decision} suggestion=${result.suggestion} label=${result.label ?? '-'} ` +
        `contentDigest=${result.contentDigest ?? '-'} policyVersion=${result.policyVersion} ` +
        `latency=${Math.round(performance.now() - imageStarted)}ms requestId=${result.requestId ?? '-'}`,
    )
  } catch (error) {
    failed = true
    console.error(`[图片] 失败：${formatError(error)}`)
  }
} else {
  console.log(`[图片] 跳过（${SAMPLE_IMAGE_PATH}）`)
}

if (failed) process.exitCode = 1
