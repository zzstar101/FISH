/**
 * 识图搜索的接口调用（#324 后端契约）：上传查询图 + 拿识别结果。
 *
 * 与发布页图片上传（`features/upload/api.ts`）**刻意不同**：查询图是 presign → 直传两步，
 * **没有 confirm**。原因在服务端：确认"这次上传算不算数"不是一次 HEAD 复核，而是搜索时
 * stat + 魔术字节重新嗅探（`apps/api/src/modules/visual-search/service.ts`）——
 * 客户端声明的 mime / 大小从不被信任（契约 `VisualQueryUploadRequestSchema` 的注释）。
 *
 * 会话标识必须在这里带上：服务端按主体派生对象键（`visual-search/{subject}/…`）与台账归属，
 * 于是 presign 与随后的搜索必须落在同一主体上（`./session` 里有完整说明）。
 */
import { RECOMMENDATION_HEADERS } from '@fish/contracts/recommendation/routes'
import {
  MAX_VISUAL_QUERY_IMAGE_BYTES,
  VisualQueryUploadResponseSchema,
  type VisualSearchResponse,
  VisualSearchResponseSchema,
} from '@fish/contracts/visual/schema'
import Taro from '@tarojs/taro'
import { assertUploadActive } from '@/features/upload/active'
import { type PickedPhoto, readFileBuffer, UPLOAD_TIMEOUT_MS } from '@/features/upload/api'
import { apiRequestWithMeta, isApiError, readResponseHeader } from '@/lib/request'
import { type VisualSearchFailure, visualSearchFailureMessage } from './messages'
import { adoptVisualSearchSessionId, ensureVisualSearchSessionId } from './session'

/**
 * 两个端点。视觉域契约目前只冻结了 schema（`packages/contracts/src/visual/schema.ts`）、
 * 没有 route 常量，服务端也是字面量注册：`apps/api/src/modules/visual-search/router.ts` 的
 * `router.post('/uploads')` 与 `router.post('/')` 挂在 `apps/api/src/app.ts` 的
 * `/visual-search` 上。所以路径在这里收口一处，等契约补上 `VISUAL_ROUTES` 再换。
 */
export const VISUAL_QUERY_UPLOAD_PATH = '/visual-search/uploads'
export const VISUAL_SEARCH_PATH = '/visual-search'

/**
 * 上传一张查询图，返回可直接拿去搜索的 `objectKey`。
 *
 * `isActive` 是调用方的在途判据（页面传 `() => taskAlive(task)`）：两步里**每一步**发请求前
 * 都会问一遍，换号 / 卸载后立刻中止（同 `uploadListingImage`，#170 复查 #208）。
 */
export async function uploadVisualQueryImage(
  photo: PickedPhoto,
  isActive?: () => boolean,
): Promise<string> {
  // 契约同源的上限：超了直接给文案，不打 API（`pickPhotos` 已按**商品图**上限挡过一次，
  // 这里按**查询图**上限再挡一次 —— 两个常量今天同值，但语义不同，不该互相绑定）
  if (photo.sizeBytes > MAX_VISUAL_QUERY_IMAGE_BYTES) {
    throw new Error(`图片不能超过 ${MAX_VISUAL_QUERY_IMAGE_BYTES / (1024 * 1024)}MB`)
  }

  assertUploadActive(isActive)
  const { data, headers } = await apiRequestWithMeta(VISUAL_QUERY_UPLOAD_PATH, {
    method: 'POST',
    body: { contentType: photo.mime, sizeBytes: photo.sizeBytes },
    // 头名与推荐域同一个（服务端视觉模块复用的就是 `readAnonymousSessionId`，见 `./session`）
    headers: { [RECOMMENDATION_HEADERS.sessionId]: ensureVisualSearchSessionId() },
  })
  // 服务端可能回写它签发的会话 id：先采纳再直传，否则这次上传的 objectKey 归到一个
  // 客户端下次不会再声明的主体上，搜索必然 400
  adoptVisualSearchSessionId(readResponseHeader(headers, RECOMMENDATION_HEADERS.sessionId))
  const presign = VisualQueryUploadResponseSchema.parse(data)

  const buffer = await readFileBuffer(photo.path)
  // 直传不携带会话（签名只覆盖 host），但它会在对象存储里留下真实对象 —— 换号后这一发同样不该再发
  assertUploadActive(isActive)
  const uploaded = await Taro.request({
    url: presign.url,
    method: 'PUT',
    data: buffer,
    // 对象存储按 PUT 的 Content-Type 落对象的 mime，而搜索时服务端要按魔术字节复核它，
    // 声明成图片白名单里的值才与本地文件一致（这里传的是本地嗅探的上限，不是用户输入）
    header: { 'content-type': photo.mime },
    timeout: UPLOAD_TIMEOUT_MS,
  })
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300) {
    throw new Error('图片上传失败,请重试')
  }
  return presign.objectKey
}

/** 把异常收窄成文案函数的输入（`isApiError` 依赖 Taro，不能放进 `./messages`）。 */
function toFailure(error: unknown): VisualSearchFailure | null {
  if (isApiError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    }
  }
  // 本地失败（读文件 / 直传 PUT 被拒 / 大小预检）：没有契约错误码，但文案比通用句子有用，
  // 所以带空码走 `./messages` 的透传分支
  if (error instanceof Error && error.message) return { code: '', message: error.message }
  return null
}

/**
 * 用已上传的查询图发起一次识图搜索。
 *
 * 与上传**必须带同一个匿名会话**（`./session`）：服务端按主体校验 `objectKey` 归属，
 * 换了 id 会直接 400「查询图不可用」。这里再 `ensureVisualSearchSessionId()` 一次是刻意的 ——
 * 上传腿可能采纳过服务端回写的 id，两次取值因此总是取到「当下这一份」。
 *
 * 失败一律抛出 `ApiError`（契约的 5 个错误码之一），由调用方用 `visualSearchErrorMessage`
 * 翻成文案；本函数**不做**演示兜底 —— 识图是真实上游调用，编不出结果。
 */
export async function searchByVisualQuery(
  objectKey: string,
  isActive?: () => boolean,
): Promise<VisualSearchResponse> {
  assertUploadActive(isActive)
  const { data } = await apiRequestWithMeta(VISUAL_SEARCH_PATH, {
    method: 'POST',
    body: { objectKey },
    headers: { [RECOMMENDATION_HEADERS.sessionId]: ensureVisualSearchSessionId() },
  })
  return VisualSearchResponseSchema.parse(data)
}

/** 页面直接用这个：收窄 + 文案一步到位 */
export function visualSearchErrorMessage(error: unknown): string {
  return visualSearchFailureMessage(toFailure(error))
}
