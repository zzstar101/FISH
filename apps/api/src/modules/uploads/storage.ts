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

  /** 读取私有对象；媒体接口在通过会话鉴权后使用。 */
  getObject?(
    key: string,
    range?: { start: number; end: number },
  ): {
    stream: ReadableStream<Uint8Array>
    contentType: string
  }

  /** 仅服务端写入验证过的快照；key 不得用于预签名上传。 */
  writeMediaBytes?(key: string, bytes: Uint8Array, contentType: string): Promise<void>

  /**
   * 读取对象的**完整字节**，用于服务端解析媒体真实属性（尺寸 / 时长）；失败或对象不存在返回 null。
   *
   * 必须是完整对象而不是文件头：WebM 的 `Duration` 缺失时要用最后一个 Cluster 的 Timecode
   * （在文件尾），MP4 的 `moov` 也可能在文件尾。只喂头部会显著低估时长，
   * 让超 60s 的录音通过校验（评审 blocker 2）。
   */
  readMediaBytes?(key: string, maxBytes?: number): Promise<Uint8Array | null>

  /** 读响应里的公开 URL，仅适用于 listings 前缀的匿名读策略。 */
  publicUrl(key: string): string
}

/** 契约 §2.7 冻结：前缀必须由服务端生成，且带上 userId 才能校验归属。 */
export const DEFAULT_PRESIGN_EXPIRES_SECONDS = 600

export function createBunS3MediaStorage(options: {
  client: Bun.S3Client
  /** 来自 `S3_PUBLIC_URL`（本地为 `http://localhost:9000/fish`）。 */
  publicUrlBase: string
  expiresInSeconds?: number
}): MediaStorage {
  const { client, publicUrlBase } = options
  const expiresInSeconds = options.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRES_SECONDS

  return {
    presignPut({ key, contentType }) {
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

    getObject(key, range) {
      const file = client.file(key)
      const body = range ? file.slice(range.start, range.end + 1) : file
      return { stream: body.stream(), contentType: file.type || 'application/octet-stream' }
    },

    async writeMediaBytes(key, bytes, contentType) {
      await client.write(key, bytes, { type: contentType })
    },

    async readMediaBytes(key, maxBytes = 10 * 1024 * 1024) {
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

    publicUrl(key) {
      return `${publicUrlBase.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`
    },
  }
}
