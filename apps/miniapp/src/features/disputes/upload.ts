/**
 * 争议附件上传链（#497）：presign → 客户端直传对象存储 → confirm。
 *
 * 与发布页（`features/upload/api.ts` 的 `uploadListingImage`）同一三步语义，**但路径不同**：
 * 争议附件的 presign/confirm 挂在 `/disputes/:id/attachments*` 上，配额与写入方（只发起人）
 * 都由服务端按争议判，不能复用发布链。
 *
 * ## 三步之间为什么要反复校验
 *
 * `apiRequest` 的 Cookie 是调用那一刻现取的。页面卸载后（换号会重定向登录页并卸载页面）再发
 * confirm，可能带着**别的账号**的会话打到不对的争议上；PUT 还会在对象存储里留下没人引用的对象。
 * 所以每次 await 前后都校验「页面还在 + 仍是发起时的登录用户」。传 `undefined` 表示不关心归属
 * （页面在压栈期间不会卸载）。
 *
 * ## confirm 失败与重试（审查发现：丢 key 会白耗配额）
 *
 * PUT 成功后对象已经在桶里、预算已经花了；若 confirm 撞上网络抖动，别把 `objectKey` 丢掉重走
 * 整条链（用户重试时又要选图、又要占一次 presign 配额）。这里在模块级记一份
 * `disputeId → objectKey`（10 分钟，和服务端附件签名 TTL 同量级）：
 * - 进入上传先尝试用记住的 key confirm（服务端 confirm 幂等，成功会清掉缓存），但**只认同一张图**
 *   （见 `fingerprintOf`：换图后旧 key 直接作废，重新 presign + PUT）；
 * - PUT 成功后立刻记住 key；confirm 成功后清除；
 * - **明确不可用**的错误（422 附件失效 / 额度满、409 已非 PENDING、404 争议不在）清掉缓存，
 *   因为重试同一个 key 只会同样失败；网络/5xx 保留，用户再点一次就能续上。
 * - 换号/卸载导致中途放弃：不发 confirm（不产生台账行），缓存也清掉 —— 那条对象没有台账行，
 *   属于服务端清理能力缺口（无公开删除端点），PR 里如实写明并并入 #500 跟进。
 */
import type { DisputeAttachment } from '@fish/contracts/disputes/schema'
import Taro from '@tarojs/taro'
import { assertUploadActive, UploadAbortedError } from '@/features/upload/active'
import { type PickedPhoto, readFileBuffer, UPLOAD_TIMEOUT_MS } from '@/features/upload/api'
import { isApiError } from '@/lib/request'
import { confirmDisputeAttachment, presignDisputeAttachment } from './api'

/** 记住的 objectKey 多久后作废（与服务端附件签名 900s TTL 同量级）。 */
const PENDING_CONFIRM_TTL_MS = 10 * 60 * 1000

type PendingConfirm = {
  objectKey: string
  expiresAt: number
  /** 这次上传的是哪一张图（`chooseMedia` 的临时路径 + 大小 + 类型）；换一张图就不许复用旧 key */
  fingerprint: string
}

/**
 * 选图指纹：只用来区分「同一张图的重试」与「用户换了另一张图」。
 *
 * `tempFilePath` 在同一个 `chooseMedia` 选择里稳定；换图/重选会拿到新路径，大小与类型再兜一层。
 * 只存 `objectKey` 不够 —— 旧实现会把「换图后的第一次 confirm」误当成续传，把上一张图挂到
 * 这条争议上（B1）。
 */
function fingerprintOf(photo: PickedPhoto): string {
  return `${photo.path}|${photo.sizeBytes}|${photo.mime}`
}

/** 模块级：页面在「PUT 成功、confirm 失败」之间重新挂载时也能续上（key 与 disputeId 绑定）。 */
const pendingConfirms = new Map<string, PendingConfirm>()

function readPendingConfirm(disputeId: string, photo: PickedPhoto, nowMs: number): string | null {
  const pending = pendingConfirms.get(disputeId)
  if (pending === undefined) return null
  if (pending.expiresAt <= nowMs) {
    pendingConfirms.delete(disputeId)
    return null
  }
  // 指纹不一致 = 用户换了另一张图：旧 key 属于上一张图，不能拿来 confirm，清掉走整条链
  if (pending.fingerprint !== fingerprintOf(photo)) {
    pendingConfirms.delete(disputeId)
    return null
  }
  return pending.objectKey
}

/** confirm 明确「再用同一个 key 也没用」的错误 → 清缓存；网络/5xx 保留以便续传。 */
function isHopelessConfirmError(error: unknown): boolean {
  if (!isApiError(error)) return false
  return error.status >= 400 && error.status < 500
}

export type DisputeUploadContext = {
  /** 页面仍挂载且没有换号/刷新（详情页的 `alive && epoch` 判据） */
  isActive?: () => boolean
  /** 当前登录用户 id：上传开始时记下，confirm 前要求仍是同一个人 */
  currentUserId?: () => string | null
}

function assertSameUser(startedBy: string | null, context: DisputeUploadContext): void {
  if (context.currentUserId === undefined) return
  if (context.currentUserId() === startedBy) return
  throw new UploadAbortedError()
}

/**
 * 上传一张争议附件，返回服务端台账行。
 *
 * 顺序：先续上次没 confirm 的 key（若有）→ presign → 读文件 → PUT → 记 key → confirm。
 */
export async function uploadDisputeAttachment(
  disputeId: string,
  photo: PickedPhoto,
  context: DisputeUploadContext = {},
): Promise<DisputeAttachment> {
  const { isActive } = context
  const startedBy = context.currentUserId?.() ?? null
  const assertSame = () => assertSameUser(startedBy, context)

  assertUploadActive(isActive)
  assertSame()

  // 1) 上次 PUT 成功但 confirm 没回来的：先用同一个 key 续 confirm（服务端幂等）
  const remembered = readPendingConfirm(disputeId, photo, Date.now())
  if (remembered !== null) {
    try {
      const confirmed = await confirmDisputeAttachment(disputeId, remembered)
      pendingConfirms.delete(disputeId)
      return confirmed.attachment
    } catch (error) {
      if (!isHopelessConfirmError(error)) throw error
      pendingConfirms.delete(disputeId)
    }
    assertUploadActive(isActive)
    assertSame()
  }

  assertUploadActive(isActive)
  assertSame()
  const presign = await presignDisputeAttachment(disputeId, {
    contentType: photo.mime,
    sizeBytes: photo.sizeBytes,
  })

  assertUploadActive(isActive)
  assertSame()
  const buffer = await readFileBuffer(photo.path)

  assertUploadActive(isActive)
  assertSame()
  const uploaded = await Taro.request({
    url: presign.uploadUrl,
    method: 'PUT',
    data: buffer,
    header: { ...presign.headers, 'content-type': photo.mime },
    timeout: UPLOAD_TIMEOUT_MS,
  })
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300) {
    throw new Error('图片上传失败，请重试')
  }
  pendingConfirms.set(disputeId, {
    objectKey: presign.objectKey,
    expiresAt: Date.now() + PENDING_CONFIRM_TTL_MS,
    fingerprint: fingerprintOf(photo),
  })

  // PUT 之后、confirm 之前再核一次归属：换号瞬间的极窄窗口里，confirm 会写到
  // 「上一个账号的争议」上（或直接 404），而桶里那条对象没人心疼 —— 不发 confirm，
  // 也就不产生台账行；缓存清掉，避免下次拿旧 key 去撞别人的争议。
  const stillMine =
    (isActive === undefined || isActive()) && startedBy === (context.currentUserId?.() ?? null)
  if (!stillMine) {
    pendingConfirms.delete(disputeId)
    throw new UploadAbortedError()
  }
  assertUploadActive(isActive)

  try {
    const confirmed = await confirmDisputeAttachment(disputeId, presign.objectKey)
    pendingConfirms.delete(disputeId)
    return confirmed.attachment
  } catch (error) {
    // 422（key 不在 / 额度满）/ 4xx（争议已非 PENDING 等）：同一个 key 再试也一样，清掉重来；
    // 网络错则保留，用户再点一次就续上（见文件头）。
    if (isHopelessConfirmError(error)) pendingConfirms.delete(disputeId)
    throw error
  }
}
