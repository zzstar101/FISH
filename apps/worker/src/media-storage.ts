/**
 * worker 侧的媒体对象存取（#324 M2/M8）。
 *
 * 为什么不复用 `apps/api/src/modules/uploads/storage.ts`：那是 API 模块，除了读字节还负责
 * 预签名、公开 URL、旧键 token 代理、审核图代理——worker 依赖它等于把整个 API 模块拉进
 * worker 的依赖图。worker 只需要两件事：**有界读对象**与**删对象**，所以这里只做这两件。
 *
 * 键形状校验与 API 侧同形（长度上限 + 字符白名单 + 拒绝 `.`/`..` 段）：`Bun.S3Client` 用
 * `new URL()` 拼地址，pathname 会把 `..` 归一化掉，脏键能让请求落到另一个对象上。
 * 这里的键来自库里的行（`listing_images.object_key` / `visual_query_images.object_key`），
 * 都经过 API 侧校验才落库，所以这一层是**纵深防御**，不是唯一入口。
 */
export type WorkerMediaStorage = {
  /**
   * 读对象的**有界**字节。键形状不合法或对象不存在返回 `null`（确定性失败）；
   * 网络 / 超时 / 5xx / 限流 / 权限抖动等**瞬时**失败抛 `WorkerMediaReadError`，
   * 由调用方按可重试处理，不能把整批补审一次性判死（审查 P1-5）。
   *
   * 多读 1 字节（`maxBytes + 1`）：调用方因此能区分"恰好到上限"与"超限"，
   * 与 API 侧 `readMediaBytes` 同一取舍。
   */
  readBytes(key: string, maxBytes: number): Promise<Uint8Array | null>
  /**
   * 删对象。**失败会抛错**（不吞）：调用方（查询图清理）必须先删对象再删台账行，
   * 吞掉失败就等于把"对象永远留在桶里"变成静默行为。
   *
   * 键形状不合法时静默返回：库里可能有脏键，但那种键本来就指不到任何对象，
   * 让调用方卡在同一行上反复失败没有意义。
   */
  deleteObject(key: string): Promise<void>
}

/**
 * 读对象失败但**值得重试**：端点不可达、超时、5xx、限流、临时权限故障。
 *
 * 与"对象不存在"（`readBytes` 返回 `null`）区分开：后者重试多少次都是同一个结果，
 * 前者否则会被当成确定性失败写进 `last_error` 并永久 `FAILED`。
 */
export class WorkerMediaReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WorkerMediaReadError'
  }
}

const MAX_OBJECT_KEY_LENGTH = 256
const SAFE_OBJECT_KEY_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

export function isSafeWorkerObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_OBJECT_KEY_LENGTH) return false
  if (!SAFE_OBJECT_KEY_PATTERN.test(key)) return false
  return !key.split('/').some((segment) => segment === '.' || segment === '..')
}

/**
 * 对象不存在才算确定性失败。`Bun.S3Error` 未导出、无法 instanceof，只能沿 cause 链
 * 按错误码判别（与 API 侧 `statStrict` 的既有取舍一致）。
 */
function isObjectMissingError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (code === 'NoSuchKey' || code === 'NotFound') return true
    current = current.cause
  }
  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createWorkerMediaStorage(client: Bun.S3Client): WorkerMediaStorage {
  return {
    async readBytes(key, maxBytes) {
      if (!isSafeWorkerObjectKey(key)) return null
      try {
        return new Uint8Array(
          await client
            .file(key)
            .slice(0, maxBytes + 1)
            .arrayBuffer(),
        )
      } catch (error) {
        // 对象不存在 → null（确定性）；其余一律按瞬时故障抛给调用方退避重试。
        if (isObjectMissingError(error)) return null
        throw new WorkerMediaReadError(`读取对象失败：${errorMessage(error)}`, { cause: error })
      }
    },

    async deleteObject(key) {
      if (!isSafeWorkerObjectKey(key)) return
      // S3 的 DELETE 对不存在的键也返回成功（幂等），所以这里的抛错是真实故障
      // （网络 / 权限 / 端点不可达），必须让调用方看见。
      await client.delete(key)
    },
  }
}
