import { encodePublicId, isPublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  DISPUTE_MEDIA_URL_TTL_SECONDS,
  disputeMediaToken,
  isDisputeMediaKey,
} from './dispute-media'
import { isLegacyListingKey, legacyMediaToken } from './legacy-url'
import {
  isListingReviewMediaKey,
  isReviewMediaPublicKey,
  REVIEW_MEDIA_URL_TTL_SECONDS,
  reviewMediaToken,
} from './review-media'

// 评价配图 final 键的形状/归属判据定义在 `./review-media`（私有媒体模块，与令牌同处）；
// 这里 re-export 维持「键域校验统一从 storage 出口拿」的既有 import 面。
export { isReviewMediaPublicKey, reviewMediaPublicPrefix } from './review-media'

/**
 * 对象存储的唯一出入口（#6 契约 §2.7 / §7.7 / §7.8）。
 *
 * 用 Bun 原生 `Bun.S3Client`：`AGENTS.md` 要求 Bun 原生 API 优先、运行时不引入 Node 适配层，
 * 而它已经提供 `presign` / `stat` / `exists` / `delete`，因此不需要 `@aws-sdk/*`，
 * 也不需要手写 SigV4（实测 presign 可用，见契约评论 §7.7）。
 *
 * 抽成 port 有两个具体原因，不是为将来预留：
 * 1. `listings` 读接口拼图片 URL 与 `uploads` 返回 URL 必须用同一个函数，
 *    两处各写一遍 `S3_PUBLIC_URL + '/' + key` 必然漂移；
 * 2. 测试不能要求真对象存储（CI 只在集成测试时需要 MinIO）。
 */
export type MediaObjectStat = { size: number; contentType: string }

export const CHAT_MEDIA_PREFIX = 'chat-media-final/'

export interface MediaStorage {
  /**
   * 预签名直传地址。
   *
   * `headers` 是"客户端必须原样附带的头"：Bun 的签名只覆盖 `host`（实测 PUT 带不带
   * `Content-Type` 都是 200），所以当前恒为空对象；保留该字段是因为换实现后可能非空，
   * 前端照着带上就不必改（契约 §7.7）。
   */
  presignPut(input: { key: string; contentType: string }): {
    url: string
    headers: Record<string, string>
    expiresAt: string
  }

  /** 对象不存在返回 `null`（不抛），由调用方决定 404 / 422 语义。 */
  stat(key: string): Promise<MediaObjectStat | null>

  /**
   * 同 `stat`，但**区分「对象不存在」与「存储故障」**：不存在返回 `null`，运行错误原样抛出。
   *
   * 背景（#483 审查响应）：`stat` 把一切错误吞成 `null`，MinIO 抖动会让评价链把可重试的
   * 服务故障回成 422「图片无效」、让用户重传毫无问题的图。评价上传链与写侧引用校验用
   * `statStrict`；其余调用方维持 `stat` 的吞错语义（既有现状，不在本票范围内改）。
   */
  statStrict?(key: string): Promise<MediaObjectStat | null>

  /**
   * 读取私有对象；媒体接口在通过会话鉴权后使用。
   *
   * 键形状不合法（见 `isSafeObjectKey`）返回 `null`：GET 路径和 HEAD 一样会被 `new URL()`
   * 归一化，所以读路径不能假定调用方已经校验过键（#86 B 线复评 P2）。
   */
  getObject?(
    key: string,
    range?: { start: number; end: number },
  ): {
    stream: ReadableStream<Uint8Array>
    contentType: string
  } | null

  /** 仅服务端写入验证过的快照；key 不得用于预签名上传。 */
  writeMediaBytes?(key: string, bytes: Uint8Array, contentType: string): Promise<void>

  /** 原子地仅在对象不存在时写入；返回 false 表示已有并发调用先完成写入。 */
  writeMediaBytesIfAbsent?(key: string, bytes: Uint8Array, contentType: string): Promise<boolean>

  /**
   * 读取对象的**完整字节**，用于服务端解析媒体真实属性（尺寸 / 时长）；失败或对象不存在返回 null。
   *
   * 必须是完整对象而不是文件头：WebM 的 `Duration` 缺失时要用最后一个 Cluster 的 Timecode
   * （在文件尾），MP4 的 `moov` 也可能在文件尾。只喂头部会显著低估时长，
   * 让超 60s 的录音通过校验（评审 blocker 2）。
   */
  readMediaBytes?(key: string, maxBytes?: number): Promise<Uint8Array | null>

  /**
   * 删除对象（#465 新增，可选）。
   *
   * 争议附件确认（`POST /disputes/:id/attachments`）在**落库失败**时要回滚已写入的对象：
   * 否则 S3 里会留下永远没有台账引用的孤儿字节。仓库里没有后台 GC 覆盖私有前缀，
   * 所以清理只能由写入方在同一个请求内完成（`visual_query_images` 那条到期清理路径
   * 是唯一的例外，但它有 `expires_at` 台账）。
   *
   * 与 `readMediaBytes` 一样，键形状不合法直接抛错；对象不存在时应为幂等成功。
   */
  delete?(key: string): Promise<void>

  /**
   * 统计某个**有界前缀**下的对象数（#465 新增，可选）。
   *
   * 争议附件的「每争议 ≤ 6 张」必须是**存储侧**配额：只数台账行挡不住「反复 presign + PUT、
   * 从不 confirm」的路径 —— 那条路径不产生行，额度永远用不完，私有前缀可被单个账号无限填充
   * （审查 P2-2）。所以签发上传地址前要数一次对象。
   *
   * 返回 `null` 表示**无法判定**（前缀形状不合法、列表失败、实现不支持）。这是成本配额而不是
   * 安全边界（安全边界是私有前缀 + 授权读），列表失败不该让上传整体不可用，调用方据此放行。
   */
  countObjects?(prefix: string): Promise<number | null>

  /**
   * 读响应里的客户端读取地址。
   *
   * - `listings/*`（公开固化）与 seed 插图 → 直链，与匿名读策略一致；
   * - `listing-review-media/*`（审核中的私有快照，#286 复审 blocker 2）与 `reviews/*`
   *   （评价配图 final 键，#483 审查响应起私有化）→ 短期签名代理地址：
   *   对象不在匿名白名单里，只有拿着这个 secret 派生、带过期时刻的令牌才能读到；
   * - `dispute-media/*`（#465 交易争议附件）→ 同样走短期签名代理，但用途派生串独立，
   *   令牌不能跨域重放；这条分支**必须**带上 `integrity.contentDigest`（见下）。
   * - 其余键一律抛错（fail-closed），不允许把未知命名空间拼进公开响应。
   *
   * 放在这里而不是每个调用点各写一遍：`listings` / `admin` / `transactions` / `conversations`
   * / `profile` 全都用这个函数拼商品图地址，审核中的图因此**不需要**改任何读模型就能显示。
   */
  publicUrl(key: string, integrity?: MediaIntegrity): string
}

/**
 * 读地址要绑定的完整性信息。
 *
 * 预签名 PUT 在有效期内可以重复使用，所以「对象键唯一」并不能保证字节不变：上传者
 * 可以在 confirm 之后对同一个 key 再 PUT 一张别的图。争议附件的读者是裁决者，
 * 因此把确认时刻的字节摘要塞进令牌，读代理只下发与摘要相符的字节。
 */
export type MediaIntegrity = { contentDigest: string }

/** 契约 §2.7 冻结：前缀必须由服务端生成，且带上 userId 才能校验归属。 */
export const DEFAULT_PRESIGN_EXPIRES_SECONDS = 600

/**
 * `countObjects` 一次最多数多少个键。
 *
 * 配额判断只关心「是否已到上限」（争议附件是 6 张），不需要精确总数，所以有界探测即可；
 * 返回的因此是真实对象数的**下界**（最多数到 100 个）。
 */
const OBJECT_COUNT_PROBE_MAX_KEYS = 100

/** objectKey 的长度上限：服务端生成的键远短于此，超长只可能是伪造输入。 */
const MAX_OBJECT_KEY_LENGTH = 256

/**
 * 形状白名单：只放行服务端自己生成的键（`listings/{uuid}/{uuid}.jpg` 形状），
 * 字符集是字母数字 + `.` `-` `_` + 段分隔 `/`。
 */
const SAFE_OBJECT_KEY_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/**
 * objectKey 形状白名单（安全边界，别删）。
 *
 * 为什么必须有：`Bun.S3Client` 用 `new URL()` 拼请求地址，而 URL 的 pathname 会**归一化**——
 * `listings/{我}/../{别人}/x.jpg` 里的 `..` 段被吃掉，实际请求的是 `listings/{别人}/x.jpg`。
 * 于是调用方那道 `objectKey.startsWith(prefix(userId))` 归属校验会被绕过：字符串确实以我的
 * 前缀开头，键却指到别人的对象上（#86 B 线评审 P1，已用真实 S3Client 复现）。
 *
 * 所以归属校验必须建立在"键里不含路径语义"这个前提上，这里就是那个前提。两道关：
 * 1. 形状白名单：`%`、反斜杠、前导 `/`、空段 `//` 都不在白名单里，一律拒绝；
 * 2. 段名检查：`.` / `..` 段能通过形状白名单，却会被 URL 归一化吃掉，必须单独拒掉。
 *
 * 不做字符串清洗（例如把 `..` 替换掉）：编码变体会不断出现，白名单才是收口的写法。
 * 实测 `%2e%2e`、`..%2f` 会被再编码成 `%252e%252e` 而不生效；但反斜杠、前导 `/`、空段 `//`
 * 同样会被 `new URL()` 归一化（只是它们先被字符集白名单挡下），所以这里一律拒绝，
 * 避免换实现或换编码层时重新打开。
 */
export function isSafeObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_OBJECT_KEY_LENGTH) return false
  if (!SAFE_OBJECT_KEY_PATTERN.test(key)) return false
  return key.split('/').every((segment) => segment !== '.' && segment !== '..')
}

export function isPublicListingKey(key: string): boolean {
  const match = /^listings\/([^/]+)\/([^/.]+)\.(?:jpg|png|webp)$/.exec(key)
  return Boolean(
    match &&
      isPublicId(PUBLIC_ID_PREFIX.user, match[1]) &&
      isPublicId(PUBLIC_ID_PREFIX.media, match[2]),
  )
}

/** Seed illustrations have stable non-resource slugs, never a user/listing UUID. */
const SEED_LISTING_KEY = /^listings\/seed-[a-z0-9-]+\/[0-9]+\.(?:jpg|png|webp)$/

/**
 * #286：**待审核**的 staging 前缀。
 *
 * 它故意不落在匿名读白名单里（`docs/deployment.md` 只放开 `listings/*` 与 `reviews/*`），因此「未审核的图天然
 * 不可被公开读到」是存储策略给的，不需要新 bucket、也不需要改 ACL。presign 只签这个前缀，
 * 所以客户端**结构上无法**覆盖已固化到 `listings/` 下的 final 对象。
 */
export const LISTING_MEDIA_PREFIX = 'listing-media/'

/** staging 键形状：`listing-media/{usr_…}/{med_…}.{ext}`（两段都必须是规范 TypeID）。 */
const LISTING_MEDIA_STAGING_KEY = /^listing-media\/([^/]+)\/([^/.]+)\.(?:jpg|png|webp)$/

/** 归属校验的前缀。与 `isPublicListingKey` 同理：键里带 userId 才不用新增"上传登记表"。 */
export function listingMediaStagingPrefix(userId: string): string {
  return `${LISTING_MEDIA_PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.user, userId)}/`
}

export function isListingMediaStagingKey(key: string): boolean {
  const match = LISTING_MEDIA_STAGING_KEY.exec(key)
  return Boolean(
    match &&
      isPublicId(PUBLIC_ID_PREFIX.user, match[1]) &&
      isPublicId(PUBLIC_ID_PREFIX.media, match[2]),
  )
}

/**
 * #475：交易评价配图的 staging 前缀（未 confirm 的临时对象；不在匿名读白名单）。
 * 与 listing 用 `listing-review-media/` 相互独立，命名上刻意带 `transaction-` 前缀避免混淆。
 * final 前缀 `reviews/` 的形状/归属判据见 `./review-media`（#483 审查响应起为私有前缀，
 * 不再匿名可读，读路径与审核中图片同走短期签名代理）。
 */
export const REVIEW_MEDIA_STAGING_PREFIX = 'transaction-review-media/'

/** staging 键形状：`transaction-review-media/{usr_…}/{med_…}.{ext}`。 */
const REVIEW_MEDIA_STAGING_KEY = /^transaction-review-media\/([^/]+)\/([^/.]+)\.(?:jpg|png|webp)$/

export function reviewMediaStagingPrefix(userId: string): string {
  return `${REVIEW_MEDIA_STAGING_PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.user, userId)}/`
}

export function isReviewMediaStagingKey(key: string): boolean {
  const match = REVIEW_MEDIA_STAGING_KEY.exec(key)
  return Boolean(
    match &&
      isPublicId(PUBLIC_ID_PREFIX.user, match[1]) &&
      isPublicId(PUBLIC_ID_PREFIX.media, match[2]),
  )
}

export function createBunS3MediaStorage(options: {
  client: Bun.S3Client
  /** 来自 `S3_PUBLIC_URL`（本地为 `http://localhost:9000/fish`）。 */
  publicUrlBase: string
  /** Web 同源 /api 代理入口，旧对象键只经加密 token 读取，绝不拼裸 UUID 直链。 */
  legacyUrlBase?: string
  legacyUrlSecret?: string
  /** 短期签名代理入口（`/api/uploads/media`）：审核中图片与评价配图这两类私有键共用。 */
  reviewUrlBase?: string
  reviewUrlSecret?: string
  /** 交易争议附件的短期签名代理入口（`/api/uploads/dispute-media`，#465）。 */
  disputeUrlBase?: string
  disputeUrlSecret?: string
  expiresInSeconds?: number
}): MediaStorage {
  const {
    client,
    publicUrlBase,
    legacyUrlBase,
    legacyUrlSecret,
    reviewUrlBase,
    reviewUrlSecret,
    disputeUrlBase,
    disputeUrlSecret,
  } = options
  const expiresInSeconds = options.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRES_SECONDS

  /** 键只应由服务端生成；形状不合法一律抛错（fail-closed），不签名也不写入。 */
  const assertSafeObjectKey = (key: string): void => {
    // 带上出错的键本身：这句话是排障时唯一的线索，而"哪个键"决定了是编码错误还是数据脏（#406 第 4 项）。
    if (!isSafeObjectKey(key)) throw new Error(`对象键形状不合法：${JSON.stringify(key)}`)
  }

  return {
    presignPut({ key, contentType }) {
      // 键由服务端拼出，形状不合法属编程错误：宁可抛错，也不要签出一个指向别人对象的 URL。
      assertSafeObjectKey(key)
      return {
        url: client.presign(key, {
          method: 'PUT',
          expiresIn: expiresInSeconds,
          type: contentType,
        }),
        headers: {},
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      }
    },

    async stat(key) {
      // 形状不合法的键直接当作"不存在"：绝不能让含 `..` 的键活着走到 URL 拼接那一层。
      // 这一层是 uploads / listings / messages 写路径共用的入口，但**不是唯一入口**：
      // getObject / readMediaBytes / writeMediaBytes / presignPut 各自也有一道，
      // 因为 GET 与 HEAD 一样会被 `new URL()` 归一化（#86 B 线评审 P1 / 复评 P2）。
      if (!isSafeObjectKey(key)) return null
      try {
        // S3Stats 是 getter 属性：Object.keys()/JSON.stringify() 都是空的，必须直接取字段。
        const info = await client.stat(key)
        return { size: info.size, contentType: info.type }
      } catch {
        // 对象不存在时 Bun 抛错，这里统一降级成 null：调用方要区分的是"有没有"，
        // 不是"为什么没拿到"，让 404 变成 500 才是真的错。
        return null
      }
    },

    async statStrict(key) {
      if (!isSafeObjectKey(key)) return null
      try {
        const info = await client.stat(key)
        return { size: info.size, contentType: info.type }
      } catch (error) {
        // 实测（本地 MinIO）：对象不存在时抛 `S3Error` 且 `code: 'NoSuchKey'`；
        // `Bun.S3Error` 未导出、无法 instanceof，按错误码判别。其余错误（网络/权限/限流）
        // 原样抛出，由调用方按可重试的服务故障处理。
        if ((error as { code?: string }).code === 'NoSuchKey') return null
        throw error
      }
    },

    getObject(key, range) {
      // GET 路径与 HEAD 一样会被 `new URL()` 归一化：脏键（例如修复前落库的行）必须在这里被拒。
      if (!isSafeObjectKey(key)) return null
      const file = client.file(key)
      const body = range ? file.slice(range.start, range.end + 1) : file
      return { stream: body.stream(), contentType: file.type || 'application/octet-stream' }
    },

    async writeMediaBytes(key, bytes, contentType) {
      assertSafeObjectKey(key)
      await client.write(key, bytes, { type: contentType })
    },

    async writeMediaBytesIfAbsent(key, bytes, contentType) {
      assertSafeObjectKey(key)
      // Bun.S3Client.write 不暴露 If-None-Match；presign 覆盖 host，故在服务端 PUT 时附加
      // S3 条件头。MinIO 返回 412 表示另一 confirm 已先成功，不得覆盖其 final 对象。
      const url = client.presign(key, {
        method: 'PUT',
        expiresIn: expiresInSeconds,
        type: contentType,
      })
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'If-None-Match': '*' },
        body: bytes,
      })
      if (response.status === 412) return false
      if (!response.ok) throw new Error(`S3 条件写入失败：HTTP ${response.status}`)
      return true
    },

    async readMediaBytes(key, maxBytes = 10 * 1024 * 1024) {
      // 守卫在 try 之前：不合法要"不发请求就拒绝"，否则请求已经打到归一化后的对象上了。
      if (!isSafeObjectKey(key)) return null
      try {
        // 有界 GET：stat 与 GET 之间上传方仍可覆盖临时对象，不能依赖旧 stat 限制内存。
        // 多读一字节，让调用方区分恰好到上限和超限对象。
        return new Uint8Array(
          await client
            .file(key)
            .slice(0, maxBytes + 1)
            .arrayBuffer(),
        )
      } catch {
        // 对象不存在或读取失败：由调用方按 fail-closed 处理。
        return null
      }
    },

    async delete(key) {
      // 与 readMediaBytes 同理：形状不合法要"不发请求就拒绝"。这里抛错而不是静默返回，
      // 因为调用方正在回滚一次失败的写入，静默失败会把孤儿对象留成"看不见的债"。
      assertSafeObjectKey(key)
      // Bun.S3Client.delete 对不存在的对象不抛错（S3 DELETE 本身幂等）。
      await client.delete(key)
    },

    async countObjects(prefix) {
      // `list` 的 prefix 走查询串（不像 key 那样会被 `new URL()` 归一化 `..`），但仍然过一遍
      // 同一个形状白名单：只允许统计规范前缀，传进来任意字符串一律拒绝。
      const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
      if (!isSafeObjectKey(normalized)) return null
      try {
        // maxKeys 只取到配额上限之上一点：这里只关心「是否已满」，不需要完整列举。
        const listed = await client.list({
          prefix: `${normalized}/`,
          maxKeys: OBJECT_COUNT_PROBE_MAX_KEYS,
        })
        return listed.keyCount ?? listed.contents?.length ?? 0
      } catch {
        // 列表失败（权限 / 网络 / 桶不可用）当作"无法判定"，由调用方按成本配额放行。
        return null
      }
    },

    publicUrl(key, integrity) {
      assertSafeObjectKey(key)
      // 私有对象（#286 审核中快照 / #475 评价配图 final 键）：不在匿名白名单里，只能通过
      // 带过期时刻的签名代理读。评价配图私有化的原因：评价读 API 是交易参与者边界，
      // 匿名直链等于给边界外的人留一条永久旁路（#483 审查响应）。
      if (isListingReviewMediaKey(key) || isReviewMediaPublicKey(key)) {
        if (!reviewUrlBase || !reviewUrlSecret) throw new Error('私有媒体 URL 代理未配置')
        const expiresAtSeconds = Math.floor(Date.now() / 1000) + REVIEW_MEDIA_URL_TTL_SECONDS
        return `${reviewUrlBase.replace(/\/+$/, '')}/${reviewMediaToken(key, reviewUrlSecret, expiresAtSeconds)}`
      }
      // 交易争议附件（#465）：同样是私有前缀 + 短期签名代理，但用途派生串独立，
      // 与审核图片的令牌互不可重放；摘要必须随令牌一起走（见 `MediaIntegrity`）。
      if (isDisputeMediaKey(key)) {
        if (!disputeUrlBase || !disputeUrlSecret) throw new Error('争议附件 URL 代理未配置')
        if (!integrity) throw new Error('争议附件读地址缺少字节摘要')
        const expiresAtSeconds = Math.floor(Date.now() / 1000) + DISPUTE_MEDIA_URL_TTL_SECONDS
        return `${disputeUrlBase.replace(/\/+$/, '')}/${disputeMediaToken(key, disputeUrlSecret, expiresAtSeconds, integrity.contentDigest)}`
      }
      if (isLegacyListingKey(key)) {
        if (!legacyUrlBase || !legacyUrlSecret) throw new Error('旧媒体 URL 代理未配置')
        return `${legacyUrlBase.replace(/\/+$/, '')}/${legacyMediaToken(key, legacyUrlSecret)}`
      }
      // New listing keys must carry strict resource TypeIDs; refuse any other shape instead of
      // silently exposing raw UUIDs or unknown object namespaces in a public response.
      if (!isPublicListingKey(key) && !SEED_LISTING_KEY.test(key)) {
        // 这一句是"真实 POST /visual-search 回 500 INTERNAL_ERROR"最常见的根因（#406 第 4 项：
        // seed 数据的三条隐性契约）。把出错的键与两种合法形状一起打出来，否则只能从 500 反推。
        throw new Error(
          `公开媒体对象键不规范：${JSON.stringify(key)}` +
            '（期望 listings/{usr_…}/{med_…}.jpg|png|webp，或 seed 演示键 listings/seed-<slug>/<n>.jpg|png|webp）',
        )
      }
      return `${publicUrlBase.replace(/\/+$/, '')}/${key}`
    },
  }
}
