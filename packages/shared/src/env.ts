import { z } from 'zod'

const ServerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_PUBLIC_URL: z.string().min(1),
})

export type ServerEnv = z.infer<typeof ServerEnvSchema>

/**
 * 服务端（api / worker）启动时统一校验环境变量，缺项直接失败而不是带病运行。
 */
export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const result = ServerEnvSchema.safeParse(source)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`环境变量校验失败（参考 .env.example）：\n${detail}`)
  }
  return result.data
}

/**
 * API 专属邮件投递配置（#68 评审二轮 P1-2）。
 *
 * `MAIL_TRANSPORT` **无默认值**：部署层必须显式声明 `outbox` 或 `resend`，
 * 忘记注入不会静默降级成 dev 投递。选 `resend` 时 Resend 两项必须齐全。
 * 只在 API 进程校验（worker 不发邮件），避免 Resend 密钥扩散到 worker。
 */
export type MailTransportEnv =
  | { transport: 'outbox' }
  | { transport: 'resend'; resendApiKey: string; resendFrom: string }

export function loadMailTransportEnv(
  source: Record<string, string | undefined> = process.env,
): MailTransportEnv {
  const mode = source.MAIL_TRANSPORT
  if (mode === 'outbox') return { transport: 'outbox' }
  if (mode === 'resend') {
    const apiKey = source.RESEND_API_KEY
    const from = source.RESEND_FROM
    if (!apiKey || !from) {
      throw new Error(
        '环境变量校验失败：MAIL_TRANSPORT=resend 必须同时配置 RESEND_API_KEY 与 RESEND_FROM',
      )
    }
    return { transport: 'resend', resendApiKey: apiKey, resendFrom: from }
  }
  throw new Error(
    '环境变量校验失败：MAIL_TRANSPORT 必须显式设置为 outbox 或 resend（不允许静默降级投递）',
  )
}

/**
 * API 专属面交码签名密钥（#70）。
 *
 * 6 位码与 QR token 在 DB 里只存带此密钥的 HMAC，明文不落库。参照 `MAIL_TRANSPORT`
 * 的同一拆分原则**不进共享 ServerEnv**：worker 不做 HMAC，高敏感密钥不扩散到
 * 不需要它的进程。强度下限 32 字符——泄漏等同可离线伪造任意面交码，与数据库同等敏感。
 */
export type MeetupTokenEnv = { MEETUP_TOKEN_SECRET: string }

export function loadMeetupTokenEnv(
  source: Record<string, string | undefined> = process.env,
): MeetupTokenEnv {
  const secret = source.MEETUP_TOKEN_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      '环境变量校验失败：MEETUP_TOKEN_SECRET 必须配置且不少于 32 字符（泄漏等同可离线伪造任意面交码）',
    )
  }
  return { MEETUP_TOKEN_SECRET: secret }
}

/**
 * API 专属 AI 润色上游配置（#141）。
 *
 * `AI_POLISH_TRANSPORT` **无默认值**：必须显式声明 `stub` 或 `live`。默认 stub 会让生产静默
 * 返回假文案，默认 live 会让"没配"看起来像"配错了"，所以缺失即启动失败。参照
 * `MAIL_TRANSPORT` / `MEETUP_TOKEN_SECRET` 的同一拆分原则**不进共享 ServerEnv**：
 * worker 不调上游，上游密钥不扩散到不需要它的进程。
 *
 * `AI_POLISH_BASE_URL` 两种 transport 都必填：stub 也是真 HTTP 服务
 * （`apps/api/scripts/ai-polish-stub.ts`），没有"进程内假实现"这种回退路径。
 */
export type AiPolishEnv =
  | { transport: 'stub'; baseUrl: string }
  | { transport: 'live'; baseUrl: string; apiKey: string; model: string }

export function loadAiPolishEnv(
  source: Record<string, string | undefined> = process.env,
): AiPolishEnv {
  const transport = source.AI_POLISH_TRANSPORT
  // 三个值都 trim 后判空并原样返回：只判真值会让 `AI_POLISH_BASE_URL='   '` 这种"看着配了、
  // 其实是空白"的配置通过启动，然后每个请求都 503——正是本加载器要避免的"配错和没配一样"。
  // transport 刻意不 trim：多一个空格仍应显式失败。
  const baseUrl = source.AI_POLISH_BASE_URL?.trim()
  if (transport === 'stub') {
    if (!baseUrl) {
      throw new Error(
        '环境变量校验失败：AI_POLISH_TRANSPORT=stub 必须配置 AI_POLISH_BASE_URL（指向 apps/api/scripts/ai-polish-stub.ts）',
      )
    }
    return { transport: 'stub', baseUrl }
  }
  if (transport === 'live') {
    const apiKey = source.AI_POLISH_API_KEY?.trim()
    const model = source.AI_POLISH_MODEL?.trim()
    if (!baseUrl || !apiKey || !model) {
      throw new Error(
        '环境变量校验失败：AI_POLISH_TRANSPORT=live 必须同时配置 AI_POLISH_BASE_URL / AI_POLISH_API_KEY / AI_POLISH_MODEL',
      )
    }
    return { transport: 'live', baseUrl, apiKey, model }
  }
  throw new Error(
    '环境变量校验失败：AI_POLISH_TRANSPORT 必须显式设置为 stub 或 live（无默认值，不允许静默回退）',
  )
}

/** 小程序码要打开的小程序版本（微信官方取值）。 */
export const WechatQrEnvVersionSchema = z.enum(['release', 'trial', 'develop'])

export type WechatQrEnvVersion = z.infer<typeof WechatQrEnvVersionSchema>

/**
 * API 专属微信身份配置（#86 评审 P1：stub 必须与生产隔离）。
 *
 * `WECHAT_TRANSPORT` **无默认值**：必须显式声明 `off` / `stub` / `live`。
 * - `off`：微信登录与手机号绑定入口关闭（`POST /auth/wechat/session` 返回 503
 *   `WECHAT_DISABLED`）——生产在拿到 AppSecret 前的安全态，不静默降级 stub。
 * - `stub`：只允许显式开发/测试（非 production）使用；`NODE_ENV=production` 下直接启动失败。
 * - `live`：真实 jscode2session / phonenumber.getPhoneNumber，AppSecret 必填。
 *
 * 手机号解析与微信登录共用同一 transport（真实接入两者都依赖同一 AppSecret 凭据）。
 */
export type WechatEnv =
  | { transport: 'off' }
  | { transport: 'stub' }
  | {
      transport: 'live'
      appid: string
      appSecret: string
      /**
       * #197 扫码登录出码的版本：`release`（默认）要求小程序**已发布**——官方明确
       * 「接口只能生成已发布的小程序的二维码」；`trial` / `develop` 用于发版前联调。
       */
      qrEnvVersion: WechatQrEnvVersion
    }

export function loadWechatEnv(
  source: Record<string, string | undefined> = process.env,
  nodeEnv: string | undefined = source.NODE_ENV,
): WechatEnv {
  // 先校验出码版本：**只要设置了就必须合法**，不因为当前 transport 是 off/stub 就放行。
  // 否则一个拼错的值会一直潜伏到切 live 的那一刻才炸。
  const qrEnvVersionRaw = source.WECHAT_QR_ENV_VERSION?.trim()
  const parsedQrEnvVersion = WechatQrEnvVersionSchema.safeParse(
    qrEnvVersionRaw === undefined || qrEnvVersionRaw === '' ? 'release' : qrEnvVersionRaw,
  )
  if (!parsedQrEnvVersion.success) {
    throw new Error(
      '环境变量校验失败：WECHAT_QR_ENV_VERSION 必须是 release / trial / develop（缺省为 release）',
    )
  }

  const transport = source.WECHAT_TRANSPORT
  if (transport === 'off') return { transport: 'off' }
  if (transport === 'stub') {
    if (nodeEnv === 'production') {
      throw new Error(
        '环境变量校验失败：生产环境（NODE_ENV=production）禁止 WECHAT_TRANSPORT=stub（stub 不验证微信签发的凭证）',
      )
    }
    return { transport: 'stub' }
  }
  if (transport === 'live') {
    const appid = source.WECHAT_APPID?.trim()
    const appSecret = source.WECHAT_APP_SECRET?.trim()
    if (!appid || !appSecret) {
      throw new Error(
        '环境变量校验失败：WECHAT_TRANSPORT=live 必须同时配置 WECHAT_APPID / WECHAT_APP_SECRET',
      )
    }
    return { transport: 'live', appid, appSecret, qrEnvVersion: parsedQrEnvVersion.data }
  }
  throw new Error(
    '环境变量校验失败：WECHAT_TRANSPORT 必须显式设置为 off / stub / live（无默认值，不允许静默回退 stub）',
  )
}

/** 腾讯云内容安全的默认地域（`TENCENT_CLOUD_REGION` 未配置时使用）。 */
export const DEFAULT_TENCENT_CLOUD_REGION = 'ap-guangzhou'

/**
 * 内容安全审核配置（#228）——API 专属，不进共享 `ServerEnv`：worker 不调审核上游。
 *
 * `CONTENT_MODERATION_TRANSPORT` **无默认值**：必须显式声明 `local` / `tencent`。
 * - `local`：只允许显式开发/测试使用。文本走本地词表（`apps/api/src/modules/moderation/rules.ts`），
 *   图片不做内容审核（一律 REVIEW，不公开）；`NODE_ENV=production` 下直接启动失败——本地词表是
 *   演示规则，不是内容安全审核，生产禁止本地兜底。
 * - `tencent`：腾讯云 TMS（文本）/ IMS（图片），四项配置缺一即失败。
 *
 * Secret 只在部署环境变量/密钥文件；本加载器只在错误里报变量名，**不回显任何值**。
 */
export type ContentModerationEnv =
  | { transport: 'local' }
  | {
      transport: 'tencent'
      secretId: string
      secretKey: string
      region: string
      tmsBizType: string
      imsBizType: string
    }

export function loadContentModerationEnv(
  source: Record<string, string | undefined> = process.env,
  nodeEnv: string | undefined = source.NODE_ENV,
): ContentModerationEnv {
  const transport = source.CONTENT_MODERATION_TRANSPORT
  if (transport === 'local') {
    // `NODE_ENV` 按 trim + 小写比较：这道生产护栏是最后一道防线，不能因为 `Production`
    // 这种拼写就失效。
    if (nodeEnv?.trim().toLowerCase() === 'production') {
      throw new Error(
        '环境变量校验失败：生产环境（NODE_ENV=production）禁止 CONTENT_MODERATION_TRANSPORT=local（本地词表不是内容安全审核，禁止生产兜底）',
      )
    }
    return { transport: 'local' }
  }
  if (transport === 'tencent') {
    const secretId = source.TENCENT_CLOUD_SECRET_ID?.trim()
    const secretKey = source.TENCENT_CLOUD_SECRET_KEY?.trim()
    const tmsBizType = source.TENCENT_TMS_BIZ_TYPE?.trim()
    const imsBizType = source.TENCENT_IMS_BIZ_TYPE?.trim()
    if (!secretId || !secretKey || !tmsBizType || !imsBizType) {
      // 点名「缺了哪一个」：只报一句「四个都要配」的话，运维无法判断到底漏了哪一项。
      const missing = [
        !secretId ? 'TENCENT_CLOUD_SECRET_ID' : null,
        !secretKey ? 'TENCENT_CLOUD_SECRET_KEY' : null,
        !tmsBizType ? 'TENCENT_TMS_BIZ_TYPE' : null,
        !imsBizType ? 'TENCENT_IMS_BIZ_TYPE' : null,
      ].filter((name): name is string => name !== null)
      throw new Error(
        `环境变量校验失败：CONTENT_MODERATION_TRANSPORT=tencent 缺少 ${missing.join(' / ')}。四项配置都必须提供：TENCENT_CLOUD_SECRET_ID / TENCENT_CLOUD_SECRET_KEY / TENCENT_TMS_BIZ_TYPE / TENCENT_IMS_BIZ_TYPE`,
      )
    }
    return {
      transport: 'tencent',
      secretId,
      secretKey,
      tmsBizType,
      imsBizType,
      region: source.TENCENT_CLOUD_REGION?.trim() || DEFAULT_TENCENT_CLOUD_REGION,
    }
  }
  throw new Error(
    '环境变量校验失败：CONTENT_MODERATION_TRANSPORT 必须显式设置为 local 或 tencent（无默认值，不允许静默回退）',
  )
}

/**
 * embedding 生成配置（#322 M1）——**worker 专属**，不进共享 `ServerEnv`：API 进程只投递
 * `EMBED_*` job、不调 embedding 上游，上游密钥不扩散到不需要它的进程（与
 * `AI_POLISH_*` / `TENCENT_CLOUD_*` 同一拆分原则）。
 *
 * `EMBEDDING_TRANSPORT` **无默认值**：必须显式声明 `stub` 或 `live`。
 * - `stub`：进程内确定性向量（`apps/worker/src/jobs/embedding/providers/stub.ts`），
 *   只允许显式开发/测试使用；`NODE_ENV=production` 下直接启动失败——确定性假向量在
 *   生产会变成"看似有语义、实则无关"的召回，比缺配置更难发现。
 * - `live`：真实上游，三项配置缺一即失败。`EMBEDDING_MODEL` 会原样写入
 *   `embeddings.model`：换模型必须显式改配置，读侧按 model 过滤，不静默混用不同模型向量。
 *
 * 本加载器只在错误里报变量名，**不回显任何值**。
 */
export type EmbeddingEnv =
  | { transport: 'stub' }
  | { transport: 'live'; baseUrl: string; apiKey: string; model: string }

/**
 * `EMBEDDING_TRANSPORT=stub` 时 `embeddings.model` 里写的模型名（#322 M1）。
 *
 * 定义在**共享包**而不是 worker 的 stub provider 里，是因为 R3 起有两个进程要认同一个名字：
 * worker 写向量、api 按 `model` 过滤向量（`loadRecommendationEmbeddingModel`）。名字一旦两边
 * 各写一份，本地开发会出现"worker 写 `stub-deterministic-v1`、api 查 `stub`"这种什么都召回
 * 不到、却又不报错的组合。worker 侧 `providers/stub.ts` 仍 re-export 这个名字，调用方不用改。
 */
export const STUB_EMBEDDING_MODEL = 'stub-deterministic-v1'

/**
 * `EMBEDDING_TRANSPORT` 的取用与护栏，两个加载器共用一份判定。
 *
 * 单独抽出来是为了让"生产禁止 stub"这条护栏只有一个实现：`loadEmbeddingEnv`（worker）与
 * `loadRecommendationEmbeddingModel`（api）如果各写一遍，早晚会有一边漏掉。
 */
function resolveEmbeddingTransport(
  source: Record<string, string | undefined>,
  nodeEnv: string | undefined,
): 'stub' | 'live' {
  const transport = source.EMBEDDING_TRANSPORT
  if (transport === 'stub') {
    // 与 `WECHAT_TRANSPORT=stub` / `CONTENT_MODERATION_TRANSPORT=local` 同一护栏，
    // `NODE_ENV` 按 trim + 小写比较，避免 `Production` 这种拼写让护栏失效。
    if (nodeEnv?.trim().toLowerCase() === 'production') {
      throw new Error(
        '环境变量校验失败：生产环境（NODE_ENV=production）禁止 EMBEDDING_TRANSPORT=stub（确定性假向量会产生看似合理的语义召回）',
      )
    }
    return 'stub'
  }
  if (transport === 'live') {
    return 'live'
  }
  throw new Error(
    '环境变量校验失败：EMBEDDING_TRANSPORT 必须显式设置为 stub 或 live（无默认值，不允许静默回退）',
  )
}

export function loadEmbeddingEnv(
  source: Record<string, string | undefined> = process.env,
  nodeEnv: string | undefined = source.NODE_ENV,
): EmbeddingEnv {
  const transport = resolveEmbeddingTransport(source, nodeEnv)
  if (transport === 'stub') {
    return { transport: 'stub' }
  }
  const baseUrl = source.EMBEDDING_BASE_URL?.trim()
  const apiKey = source.EMBEDDING_API_KEY?.trim()
  const model = source.EMBEDDING_MODEL?.trim()
  if (!baseUrl || !apiKey || !model) {
    // 点名「缺了哪一个」，而不是只说「三个都要配」。
    const missing = [
      !baseUrl ? 'EMBEDDING_BASE_URL' : null,
      !apiKey ? 'EMBEDDING_API_KEY' : null,
      !model ? 'EMBEDDING_MODEL' : null,
    ].filter((name): name is string => name !== null)
    throw new Error(
      `环境变量校验失败：EMBEDDING_TRANSPORT=live 缺少 ${missing.join(' / ')}。三项配置都必须提供：EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL`,
    )
  }
  return { transport: 'live', baseUrl, apiKey, model }
}

/**
 * 读侧（api）需要的 embedding 配置（#323 R3）：**只要模型名**，不碰上游密钥。
 *
 * 为什么 api 需要它：R3 的语义召回要拿"当前写入向量用的模型"去过滤 `embeddings`，否则
 * 换过模型之后库里的老向量会被当成有效候选。判断这件事只需要 `EMBEDDING_MODEL`。
 *
 * 为什么单独开一个加载器而不是复用 `loadEmbeddingEnv`：后者对 `live` 强制要求
 * `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY`，api 进程根本不用这两个值。复用会把上游密钥
 * 变成 api 的启动依赖——为了读一个模型名而让密钥扩散到不需要它的进程，是与
 * `AI_POLISH_*` / `TENCENT_CLOUD_*` 拆分原则相反的做法。
 *
 * 与 worker 一致：`EMBEDDING_TRANSPORT` 无默认值，生产禁止 `stub`；错误信息只报变量名、不回显值。
 */
export type RecommendationEmbeddingModelEnv = { model: string }

export function loadRecommendationEmbeddingModel(
  source: Record<string, string | undefined> = process.env,
  nodeEnv: string | undefined = source.NODE_ENV,
): RecommendationEmbeddingModelEnv {
  const transport = resolveEmbeddingTransport(source, nodeEnv)
  if (transport === 'stub') {
    return { model: STUB_EMBEDDING_MODEL }
  }
  const model = source.EMBEDDING_MODEL?.trim()
  if (!model) {
    throw new Error(
      '环境变量校验失败：EMBEDDING_TRANSPORT=live 缺少 EMBEDDING_MODEL（api 只用它按 model 过滤向量，不需要 EMBEDDING_BASE_URL / EMBEDDING_API_KEY）',
    )
  }
  return { model }
}

/**
 * 埋点 / Feed 限流阈值的**可选覆盖**（#323 R6 §8.1）。
 *
 * 默认值不在这里：它属于契约（`RECOMMENDATION_EVENT_RATE_LIMIT` / `RECOMMENDATION_FEED_RATE_LIMIT`，
 * `packages/contracts/src/recommendation/observability.ts`），因为 worker、CLI 与文档都要读同一份数字。
 * 而 `packages/shared` **不能** import `@fish/contracts`（方向是 shared ← contracts，反过来成环），
 * 所以这里只回答"有没有覆盖值"：未配置 → `null`，由 API 侧 `?? 默认值` 合并。
 *
 * 非法值（0、负数、非数字）**直接抛**而不是回退默认：配错限流阈值属于"以为限住了其实没限"，
 * 静默回退会让这种误配一直活着。错误信息只报变量名，不回显值。
 */
export type RecommendationRateLimitEnv = {
  eventCapacity: number | null
  eventRefillPerSecond: number | null
  feedCapacity: number | null
  feedRefillPerSecond: number | null
}

function readPositiveNumber(
  source: Record<string, string | undefined>,
  name: string,
): number | null {
  const raw = source[name]?.trim()
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`环境变量校验失败：${name} 必须是正数（当前值不合法）`)
  }
  return value
}

export function loadRecommendationRateLimitEnv(
  source: Record<string, string | undefined> = process.env,
): RecommendationRateLimitEnv {
  return {
    eventCapacity: readPositiveNumber(source, 'RECOMMENDATION_EVENT_RATE_LIMIT_CAPACITY'),
    eventRefillPerSecond: readPositiveNumber(
      source,
      'RECOMMENDATION_EVENT_RATE_LIMIT_REFILL_PER_SECOND',
    ),
    feedCapacity: readPositiveNumber(source, 'RECOMMENDATION_FEED_RATE_LIMIT_CAPACITY'),
    feedRefillPerSecond: readPositiveNumber(
      source,
      'RECOMMENDATION_FEED_RATE_LIMIT_REFILL_PER_SECOND',
    ),
  }
}

/**
 * 视觉向量配置（#324 M1/M8）——**API 与 worker 都要**。
 *
 * 与上面 `EMBEDDING_*`「worker 专属」的取舍刻意不同，理由是调用时机：
 * 商品的封面向量可以在后台慢慢回填（worker），但**查询图的向量必须在搜索请求里当场算出来**
 * （查询图只活 15 分钟，为它投一条 job 再等 worker 轮询会让首屏延迟不可控）。所以
 * 上游密钥必须同时存在于 API 进程。这扩大了密钥的可见范围，是 #324 明确的取舍：
 * 换来的是"拍照 → 结果"这条主链路不依赖队列延迟。`.env.example` 与 PR 描述里都写明了。
 *
 * `VISUAL_EMBEDDING_TRANSPORT` **无默认值**（与 EMBEDDING_TRANSPORT 同一护栏）：
 * - `stub`：进程内确定性向量，只允许显式开发/测试使用，`NODE_ENV=production` 下启动失败；
 * - `live`：真实上游，三项配置缺一即失败。
 *
 * 维度不在这里配置：迁移里的列是 `vector(1024)`，维度是**编译期常量**
 * （`VISUAL_EMBEDDING_DIMENSIONS`）。所以 `VISUAL_EMBEDDING_MODEL` 必须支持 1024 维
 * （`qwen3-vl-embedding` / `tongyi-embedding-vision-plus-2026-03-06` 等），
 * 不支持的模型会在第一次调用时以"维度不符"失败，而不是悄悄写进一个对不上的列。
 */
export type VisualEmbeddingEnv =
  | { transport: 'stub' }
  | { transport: 'live'; baseUrl: string; apiKey: string; model: string }

export function loadVisualEmbeddingEnv(
  source: Record<string, string | undefined> = process.env,
  nodeEnv: string | undefined = source.NODE_ENV,
): VisualEmbeddingEnv {
  const transport = source.VISUAL_EMBEDDING_TRANSPORT
  if (transport === 'stub') {
    if (nodeEnv?.trim().toLowerCase() === 'production') {
      throw new Error(
        '环境变量校验失败：生产环境（NODE_ENV=production）禁止 VISUAL_EMBEDDING_TRANSPORT=stub（确定性假向量会产生看似合理的图片召回）',
      )
    }
    return { transport: 'stub' }
  }
  if (transport === 'live') {
    const baseUrl = source.VISUAL_EMBEDDING_BASE_URL?.trim()
    const apiKey = source.VISUAL_EMBEDDING_API_KEY?.trim()
    const model = source.VISUAL_EMBEDDING_MODEL?.trim()
    if (!baseUrl || !apiKey || !model) {
      const missing = [
        !baseUrl ? 'VISUAL_EMBEDDING_BASE_URL' : null,
        !apiKey ? 'VISUAL_EMBEDDING_API_KEY' : null,
        !model ? 'VISUAL_EMBEDDING_MODEL' : null,
      ].filter((name): name is string => name !== null)
      throw new Error(
        `环境变量校验失败：VISUAL_EMBEDDING_TRANSPORT=live 缺少 ${missing.join(' / ')}。三项配置都必须提供：VISUAL_EMBEDDING_BASE_URL / VISUAL_EMBEDDING_API_KEY / VISUAL_EMBEDDING_MODEL`,
      )
    }
    return { transport: 'live', baseUrl, apiKey, model }
  }
  throw new Error(
    '环境变量校验失败：VISUAL_EMBEDDING_TRANSPORT 必须显式设置为 stub 或 live（无默认值，不允许静默回退）',
  )
}

/**
 * 查询图的语义解析（#324 M5，OCR/VLM）配置。
 *
 * - `off`：**不做**语义解析。搜索退化为"纯视觉召回 + 结构化信号"（freshness / popularity），
 *   没有文本路加权。这是 CI 与本机默认：整条链路不出网、不需要多模态理解模型的额度。
 *   注意这里的 `off` 与 `EMBEDDING_TRANSPORT=stub` 性质不同——它不产生"看似合理的假结果"，
 *   只是少做一步可选增强，所以**有默认值**（未设置即 off），不需要每个部署显式声明。
 * - `live`：调用 OpenAI 兼容的 `chat/completions`（百炼为
 *   `https://dashscope.aliyuncs.com/compatible-mode/v1`），模型返回严格 JSON。
 *   缺任何一项配置就在启动期失败，而不是等第一次搜索才发现解析永远为空。
 */
export type VisualParseEnv =
  | { transport: 'off' }
  | { transport: 'live'; baseUrl: string; apiKey: string; model: string }

export function loadVisualParseEnv(
  source: Record<string, string | undefined> = process.env,
): VisualParseEnv {
  const transport = source.VISUAL_PARSE_TRANSPORT?.trim() || 'off'
  if (transport === 'off') return { transport: 'off' }
  if (transport === 'live') {
    const baseUrl = source.VISUAL_PARSE_BASE_URL?.trim()
    const apiKey = source.VISUAL_PARSE_API_KEY?.trim()
    const model = source.VISUAL_PARSE_MODEL?.trim()
    if (!baseUrl || !apiKey || !model) {
      const missing = [
        !baseUrl ? 'VISUAL_PARSE_BASE_URL' : null,
        !apiKey ? 'VISUAL_PARSE_API_KEY' : null,
        !model ? 'VISUAL_PARSE_MODEL' : null,
      ].filter((name): name is string => name !== null)
      throw new Error(
        `环境变量校验失败：VISUAL_PARSE_TRANSPORT=live 缺少 ${missing.join(' / ')}。三项配置都必须提供：VISUAL_PARSE_BASE_URL / VISUAL_PARSE_API_KEY / VISUAL_PARSE_MODEL`,
      )
    }
    return { transport: 'live', baseUrl, apiKey, model }
  }
  throw new Error('环境变量校验失败：VISUAL_PARSE_TRANSPORT 只能是 off 或 live（未设置视为 off）')
}
