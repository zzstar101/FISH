import { type WechatQrEnvVersion, WechatQrEnvVersionSchema } from '@fish/shared/env'
import {
  isInvalidAccessTokenErrcode,
  WECHAT_PLATFORM_TIMEOUT_MS,
  type WechatAccessTokenService,
  WechatPlatformError,
} from '../wechat/access-token'

/**
 * 微信平台侧出码能力（#197）：`getwxacodeunlimit` 小程序码。
 *
 * 接口调用凭据（access_token 的缓存 / 单飞 / 退避）已下沉到共用模块
 * `apps/api/src/modules/wechat/access-token.ts`（#294，#204 手机号换取共用同一实例），
 * 本文件只负责取码本身的参数校验与响应解析，凭证经 `deps.tokens` 注入。
 */

/**
 * 官方对 `scene` 的约束：最大 32 个可见字符，只支持数字、大小写英文与
 * `!#$&'()*+,/:;=?@-._~`；**不支持 `%`**，所以中文无法用 urlencode 处理。
 *
 * 先在这里拦一道，否则会把必然 40129/40169 的请求打到上游——那样本地就分不清
 * 「参数写错」与「平台故障」，最终只能笼统报成取码失败。
 */
const SCENE_PATTERN = /^[A-Za-z0-9!#$&'()*+,:/;=?@._~-]{1,32}$/

/** `getwxacodeunlimit` 的宽度限制（官方：默认 430，最小 280，最大 1280）。 */
export const WECHAT_QR_MIN_WIDTH = 280
export const WECHAT_QR_MAX_WIDTH = 1280

export type WechatMiniappCodeRequest = {
  /** 印进二维码的页面参数；长度上限 32 个可见字符（官方）。 */
  scene: string
  /** 不带前导 `/`，且**不能带参数**（参数只能放进 scene）。 */
  page: string
  envVersion: WechatQrEnvVersion
  /** 官方默认 430，范围 280–1280。不传即用官方默认。 */
  width?: number
}

export type WechatMiniappCodeClient = {
  /** 成功直接返回图片二进制；失败抛 `WechatPlatformError`。 */
  unlimited(input: WechatMiniappCodeRequest): Promise<Uint8Array>
}

export function createWechatMiniappCodeClient(deps: {
  tokens: WechatAccessTokenService
  fetchImpl?: typeof fetch
  /** 注入点：单测把超时压到毫秒级。 */
  timeoutMs?: number
}): WechatMiniappCodeClient {
  const doFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    (deps.fetchImpl ?? fetch)(input, init)
  const timeoutMs = deps.timeoutMs ?? WECHAT_PLATFORM_TIMEOUT_MS

  return {
    async unlimited(input) {
      // 这些校验在 TS 之外也必须有：调用方可能是 JS、测试桩或将来绕过类型的代码。
      // 放行非法值的后果是「本地配置写错」被误报成平台故障（502）。
      if (!WechatQrEnvVersionSchema.safeParse(input.envVersion).success) {
        throw new WechatPlatformError('envVersion 必须是 release / trial / develop')
      }
      if (input.page.length === 0 || input.page.startsWith('/') || /[?#]/.test(input.page)) {
        throw new WechatPlatformError('page 不能为空、不能带前导 /，也不能带参数（参数放进 scene）')
      }
      // 官方：scene 最大 32 个可见字符且字符集受限（见 SCENE_PATTERN）。
      if (!SCENE_PATTERN.test(input.scene)) {
        throw new WechatPlatformError(
          'scene 不合法：最多 32 个可见字符，且只支持微信白名单字符（不支持 %）',
        )
      }
      // 官方：宽度默认 430，最小 280、最大 1280。必须同时是整数——
      // 只比大小会让 NaN（比较恒 false）与 280.5 这类值漏过去，请求体里变成 null / 小数。
      if (
        input.width !== undefined &&
        (!Number.isInteger(input.width) ||
          input.width < WECHAT_QR_MIN_WIDTH ||
          input.width > WECHAT_QR_MAX_WIDTH)
      ) {
        throw new WechatPlatformError(
          `width 必须是 ${WECHAT_QR_MIN_WIDTH}–${WECHAT_QR_MAX_WIDTH} 之间的整数`,
        )
      }

      const token = await deps.tokens.get()
      const url = new URL('https://api.weixin.qq.com/wxa/getwxacodeunlimit')
      url.searchParams.set('access_token', token)

      let res: Response
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scene: input.scene,
            page: input.page,
            // 官方：默认 true 时 page 必须是**已发布**小程序里存在的页面。
            // release 用默认值把「页面写错」拦在这里；trial / develop 放行未发布页面。
            check_path: input.envVersion === 'release',
            env_version: input.envVersion,
            ...(input.width === undefined ? {} : { width: input.width }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        const kind = error instanceof Error ? error.name : 'unknown'
        throw new WechatPlatformError(`getwxacodeunlimit 请求失败（${kind}）`)
      }

      // HTTP media type 大小写不敏感，且可能带 `; charset=...`：先归一化再比。
      const mediaType =
        (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

      // 成功判定用**白名单**且要求 2xx：只有 `image/*` 才算拿到码。反过来判
      // （「不是 JSON 就当图片」）会把网关的 text/html 错误页、缺 Content-Type 的响应、
      // 被标成 text/plain 的微信错误体当成二维码字节返回；只看 content-type 又会让
      // 「HTTP 500 + image/jpeg」这种网关错误页蒙混过关——两种都会让取码失败失去
      // 与 transport 未开通区分开的错误路径。
      if (res.ok && mediaType.startsWith('image/')) {
        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(await res.arrayBuffer())
        } catch (error) {
          // body 读取失败（连接中断 / 流错误）。原始异常可能带请求 URL（含 access_token），
          // 只保留错误类型名——与请求阶段同一口径。
          const kind = error instanceof Error ? error.name : 'unknown'
          throw new WechatPlatformError(`getwxacodeunlimit 读取响应失败（${kind}）`)
        }
        if (bytes.byteLength === 0) throw new WechatPlatformError('getwxacodeunlimit 返回了空图片')
        return bytes
      }

      // 失败路径：能解析出整数 errcode 就用它（结构化字段，**不带**上游原文 errmsg
      // 与 content-type 这类可控文本），否则如实报 HTTP 状态。
      const body = (await res.json().catch(() => null)) as { errcode?: unknown } | null
      const errcode =
        typeof body?.errcode === 'number' && Number.isInteger(body.errcode)
          ? body.errcode
          : undefined
      if (errcode !== undefined) {
        // 命中失效码就丢掉**这一个** token（见 invalidate 的参数语义）。
        if (isInvalidAccessTokenErrcode(errcode)) deps.tokens.invalidate(token)
        throw new WechatPlatformError(`getwxacodeunlimit errcode=${errcode}`, errcode)
      }
      if (!res.ok) throw new WechatPlatformError(`getwxacodeunlimit HTTP ${res.status}`)
      // 不把 content-type 原文拼进来：它同样是上游可控的文本。
      throw new WechatPlatformError(`getwxacodeunlimit 未返回图片（HTTP ${res.status}）`)
    },
  }
}
