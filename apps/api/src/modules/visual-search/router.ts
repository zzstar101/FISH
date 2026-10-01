import { RECOMMENDATION_HEADERS } from '@fish/contracts/recommendation/routes'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import {
  VisualQueryUploadRequestSchema,
  VisualSearchRequestSchema,
} from '@fish/contracts/visual/schema'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { VisualSearchRateLimitError } from './rate-limit'
import { type VisualSearchService, VisualSearchServiceError } from './service'
import type { VisualSearchSubjectResolver } from './subject'

/**
 * 拍照识图搜索的路由（#324 M4）。
 *
 * 两个端点都是**匿名可用**（Q6=B）：拍照搜图是公开入口，与 listings 的"读公开、写必须登录"
 * 同一条分界——它不产生任何归属用户的内容，只产生一次计费的上游调用，而那个由配额把关。
 * 所以这里没有 `requireAuth`，只有**可选**身份解析（登录则按 userId 计配额）。
 *
 * `POST /visual-search/uploads` 与 `POST /visual-search` 分开（契约 §`VisualSearchRequestSchema`）：
 * 上传失败与识别失败因此有各自的错误码与重试语义，不必让客户端从 multipart 的失败里猜。
 */
export type VisualSearchRouterOptions = {
  service: VisualSearchService
  subjects: VisualSearchSubjectResolver
  /** 可选身份：匿名返回 null（配额退化为按会话 + IP 计）。 */
  resolveViewerId: (c: Context) => Promise<string | null>
  resolveClientIp: (c: Context) => string | null
}

/** JSON 解析失败（空体 / 非 JSON）按参数不合法处理，而不是让 Hono 抛 500。 */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

function zodValidationFailure(
  c: Context,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
) {
  return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(issues)), 422)
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof VisualSearchServiceError) {
    if (error.retryAfterSeconds !== undefined) {
      c.header('Retry-After', String(error.retryAfterSeconds))
    }
    return c.json(
      errorBody(error.code, error.message, undefined, error.retryAfterSeconds),
      error.status,
    )
  }
  if (error instanceof VisualSearchRateLimitError) {
    // 限额的剩余秒数走结构化字段（与 #141 的 `number-lookup` 同一形态），
    // header 只是给中间层/网关的兜底提示。
    c.header('Retry-After', String(error.retryAfterSeconds))
    return c.json(
      errorBody('VISUAL_SEARCH_RATE_LIMITED', error.message, undefined, error.retryAfterSeconds),
      429,
    )
  }
  throw error
}

export function createVisualSearchRouter(options: VisualSearchRouterOptions) {
  const { service, subjects } = options
  const router = new Hono<{ Variables: AuthVariables }>()

  /**
   * 解析本次请求的主体。匿名且客户端没带会话标识时**新签一个并回写响应头**：
   * 上传与搜索必须落在同一主体下（对象键与台账都按主体归属），否则客户端拿到的
   * `objectKey` 属于一个它下次不会再声明的主体，搜索必然 400。
   */
  async function resolveSubject(c: Context) {
    const subject = await subjects.resolve(
      c,
      await options.resolveViewerId(c),
      options.resolveClientIp(c),
    )
    if (subject.issuedSessionId !== null) {
      c.header(RECOMMENDATION_HEADERS.sessionId, subject.issuedSessionId)
    }
    return subject
  }

  // —— 查询图上传：拿 presign，然后客户端直传私有前缀 ——

  router.post('/uploads', async (c) => {
    const parsed = VisualQueryUploadRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    const subject = await resolveSubject(c)
    try {
      // 200 而不是 201：这里没有创建"资源"，只是签了一个稍后才存在的对象的直传地址
      // （与 `POST /uploads/presign` 同形）。
      return c.json(await service.createUpload(subject, parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // —— 拍照搜图 ——

  router.post('/', async (c) => {
    const parsed = VisualSearchRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    const subject = await resolveSubject(c)
    try {
      return c.json(await service.search(subject, parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}
