/**
 * 「保存资料」任务的**会话绑定**（#86 B 线复评 P1）。
 *
 * ## 为什么需要它
 *
 * 保存是**多段异步**：读本地头像 → presign → 直传对象存储 → confirm → `PATCH /profile`
 * （见 `apps/miniapp/src/pages/profile-edit/index.tsx` 的头注释）。每一段都是鉴权请求，
 * 用的是**发请求那一刻**的会话。用户在传头像期间退出或换号后：
 *
 * 1. 后面的 `PATCH /profile` 会带着**新账号**的凭据，把**旧账号**的草稿写进新账号；
 * 2. 迟到的成功回调还会弹「已保存」、`applyProfile` 广播旧账号的昵称、并把页面返回掉。
 *
 * 只比对「响应里的 `user.id` === 发请求时的 `user.id`」**不够**：那只证明响应属于发请求
 * 时的那个账号，不能证明现在登录的还是同一个人（同 `apps/miniapp/src/lib/cancellable.ts`
 * 的结论）。唯一可靠的做法是**在每次发鉴权请求之前**再问一次「这个任务还属于当前会话吗」，
 * 所以校验点必须夹在上传与 PATCH 之间，而不是只在响应侧比对。
 *
 * 本模块**不 import Taro**：页面负责平台层与渲染，这里只做能在 bun 里直接测的编排。
 */
import type { Me } from '@fish/contracts/auth/user'
import type { ProfileUpdateRequest } from '@fish/contracts/profile/schema'
import type { PickedPhoto } from '@/features/upload/api'
import { nicknameError, profileUpdateBody } from './avatar'

/**
 * 会话标识：`ownerId` + **代次**。
 *
 * 代次在换号 / 登出 / 卸载时前进，用来作废在途任务。只看 `ownerId` 不够 ——
 * 退出再登回同一个账号时 `ownerId` 没变，但旧任务用的凭据已经不该继续用了。
 */
export type SessionKey = {
  ownerId: string | null
  epoch: number
}

/** 一次保存任务的凭据：开任务那一刻的会话 + 任务号。 */
export type SaveTicket = SessionKey & { id: number }

/** 渲染期身份清场：`ownerId` 变了就前进一代，在途任务随之作废。 */
export function advanceSession(prev: SessionKey, ownerId: string | null): SessionKey {
  return prev.ownerId === ownerId ? prev : { ownerId, epoch: prev.epoch + 1 }
}

/** 这个任务还属于当前会话吗 —— **每次发鉴权请求前**都要问一次。 */
export function isTicketCurrent(ticket: SaveTicket, key: SessionKey): boolean {
  return ticket.ownerId === key.ownerId && ticket.epoch === key.epoch
}

/** 本次保存要用的草稿（页面 state 的快照）。 */
export type ProfileDraft = {
  nickname: string
  /** 本次选中的本地临时头像（仅预览）；没选就是 `null` */
  avatarPath: string | null
  /** 上一次上传成功的 `objectKey`；换过头像就作废 */
  uploaded: { path: string; objectKey: string } | null
}

export type SaveDeps = {
  /** 读本地临时头像 → 上传链要的 `PickedPhoto` */
  readAvatarPhoto(path: string): Promise<PickedPhoto>
  /** 直传头像，返回 `objectKey` */
  uploadAvatar(photo: PickedPhoto): Promise<string>
  /** `PATCH /profile` */
  patchProfile(body: ProfileUpdateRequest): Promise<Me>
  /** 读**当前**会话（不是开任务时那个） */
  session(): SessionKey
  /** 阶段推进（页面据此禁用输入并显示进度） */
  onPhase(phase: 'uploading' | 'saving'): void
  /** 头像上传成功，页面记下来免得重复上传 */
  onUploaded(path: string, objectKey: string): void
}

export type SaveOutcome =
  /** 落库成功；`ownerId` 是**发起任务那个**账号，页面据此广播 */
  | { kind: 'saved'; ownerId: string; nickname: string; avatarUrl: string | null }
  /** 会话已变 / 页面已卸载：没 PATCH、没弹成功、没导航 */
  | { kind: 'aborted' }
  /** 没有需要保存的修改 */
  | { kind: 'no-change' }
  /** 昵称预检不过 */
  | { kind: 'nickname-invalid'; message: string }
  /** 请求或本地预检抛错，交页面分类成文案 */
  | { kind: 'failed'; error: unknown }

/**
 * 跑一次保存。返回 `aborted` 时页面必须**什么都不做**：不弹成功、不广播、不导航，
 * 也不要把阶段收回 `idle`（换号那条路径由页面的身份清场 effect 负责复位）。
 */
export async function runProfileSave(
  input: { ticket: SaveTicket; ownerId: string; ownerNickname: string; draft: ProfileDraft },
  deps: SaveDeps,
): Promise<SaveOutcome> {
  const alive = () => isTicketCurrent(input.ticket, deps.session())

  const badNickname = nicknameError(input.draft.nickname)
  if (badNickname) return { kind: 'nickname-invalid', message: badNickname }

  // 已传过的头像直接用现成 objectKey（省一次重复上传）；否则需要先传新头像
  const readyObjectKey =
    input.draft.uploaded && input.draft.uploaded.path === input.draft.avatarPath
      ? input.draft.uploaded.objectKey
      : null
  const needsUpload = input.draft.avatarPath !== null && readyObjectKey === null

  const unchanged =
    profileUpdateBody(input.ownerNickname, {
      nickname: input.draft.nickname,
      avatarObjectKey: readyObjectKey,
    }) === null
  if (unchanged && !needsUpload) return { kind: 'no-change' }

  try {
    let objectKey = readyObjectKey
    if (needsUpload && input.draft.avatarPath !== null) {
      deps.onPhase('uploading')
      const photo = await deps.readAvatarPhoto(input.draft.avatarPath)
      if (!alive()) return { kind: 'aborted' }
      objectKey = await deps.uploadAvatar(photo)
      if (!alive()) return { kind: 'aborted' }
      deps.onUploaded(input.draft.avatarPath, objectKey)
    }

    deps.onPhase('saving')
    const body = profileUpdateBody(input.ownerNickname, {
      nickname: input.draft.nickname,
      avatarObjectKey: objectKey,
    })
    if (body === null) return { kind: 'no-change' }
    // 换号后绝不发这个 PATCH：它带的是新账号的凭据，会把旧账号草稿写进新账号
    if (!alive()) return { kind: 'aborted' }

    const updated = await deps.patchProfile(body)
    if (!alive()) return { kind: 'aborted' }
    return {
      kind: 'saved',
      ownerId: input.ownerId,
      nickname: updated.nickname,
      avatarUrl: updated.avatarUrl,
    }
  } catch (error) {
    // 迟到的失败也不该给新账号弹旧账号的错误
    if (!alive()) return { kind: 'aborted' }
    return { kind: 'failed', error }
  }
}
