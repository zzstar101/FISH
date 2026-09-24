import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type { ProfileUpdateRequest } from '@fish/contracts/profile/schema'
import {
  advanceSession,
  isTicketCurrent,
  runProfileSave,
  type SaveDeps,
  type SaveOutcome,
  type SaveTicket,
  type SessionKey,
} from '../src/features/profile/save'
import type { PickedPhoto } from '../src/features/upload/api'

/**
 * 「保存资料」任务的会话绑定（#86 B 线复评 P1）回归。
 *
 * 修复前的 `pages/profile-edit` 的 `save()` 是一串裸 await：读头像 → 直传 → `PATCH /profile`
 * 之间**没有任何会话校验**，所以换号之后旧账号的草稿会被 PATCH 进新账号，迟到的成功回调
 * 还会弹「已保存」并把页面返回掉。
 *
 * 这里钉的是那条不变量：**每次发鉴权请求之前都要再问一次「这个任务还属于当前会话吗」**。
 * 把 `src/features/profile/save.ts` 里夹在上传与 PATCH 之间的任意一个 `if (!alive())` 去掉，
 * 下面就有用例立刻失败（见每个用例的注释标注了它守的是哪一处）。
 */

const U1: Me = {
  id: '11111111-1111-4111-8111-111111111111',
  nickname: '旧昵称',
  avatarUrl: null,
  authStatus: 'VERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}

const OTHER_OWNER = '22222222-2222-4222-8222-222222222222'
const PHOTO: PickedPhoto = { path: 'wxfile://tmp_avatar_1.png', mime: 'image/png', sizeBytes: 2048 }
const OBJECT_KEY = 'users/u1/avatar/1.png'

/** 一次保存里所有对外可见的副作用，用来断言「什么都没发生」。 */
type SideEffects = {
  patched: ProfileUpdateRequest[]
  uploaded: number
  uploadedKeys: Array<{ path: string; objectKey: string }>
  phases: Array<'uploading' | 'saving'>
}

function makeEffects(): SideEffects {
  return { patched: [], uploaded: 0, uploadedKeys: [], phases: [] }
}

/**
 * 组一个可注入的 `SaveDeps`。`session()` 读的是**闭包里的当前会话**，
 * 用例可以在任意一段 await 中途改它来模拟「换号 / 退出 / 卸载」。
 */
function makeDeps(options: {
  effects: SideEffects
  session: () => SessionKey
  readAvatarPhoto?: SaveDeps['readAvatarPhoto']
  uploadAvatar?: SaveDeps['uploadAvatar']
  patchProfile?: SaveDeps['patchProfile']
}): SaveDeps {
  return {
    readAvatarPhoto: options.readAvatarPhoto ?? (async () => PHOTO),
    uploadAvatar:
      options.uploadAvatar ??
      (async () => {
        options.effects.uploaded += 1
        return OBJECT_KEY
      }),
    patchProfile:
      options.patchProfile ??
      (async (body) => {
        options.effects.patched.push(body)
        return { ...U1, nickname: body.nickname ?? U1.nickname }
      }),
    session: options.session,
    onPhase: (phase) => options.effects.phases.push(phase),
    onUploaded: (path, objectKey) => options.effects.uploadedKeys.push({ path, objectKey }),
  }
}

function ticketOf(key: SessionKey): SaveTicket {
  return { ...key, id: 1 }
}

function input(overrides: Partial<Parameters<typeof runProfileSave>[0]> = {}) {
  return {
    ticket: ticketOf({ ownerId: U1.id, epoch: 0 }),
    ownerId: U1.id,
    ownerNickname: U1.nickname,
    draft: { nickname: '新昵称', avatarPath: PHOTO.path, uploaded: null },
    ...overrides,
  }
}

describe('runProfileSave：会话与代次', () => {
  test('没换号：正常上传并 PATCH，返回发起账号', async () => {
    const effects = makeEffects()
    const key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const deps = makeDeps({
      effects,
      session: () => key,
      patchProfile: async (body) => {
        effects.patched.push(body)
        return { ...U1, nickname: body.nickname ?? U1.nickname, avatarUrl: 'https://cdn/a.png' }
      },
    })

    const outcome = await runProfileSave(input(), deps)

    expect(outcome).toEqual({
      kind: 'saved',
      ownerId: U1.id,
      nickname: '新昵称',
      avatarUrl: 'https://cdn/a.png',
    })
    expect(effects.phases).toEqual(['uploading', 'saving'])
    expect(effects.uploaded).toBe(1)
    expect(effects.uploadedKeys).toEqual([{ path: PHOTO.path, objectKey: OBJECT_KEY }])
    expect(effects.patched).toEqual([{ nickname: '新昵称', avatarObjectKey: OBJECT_KEY }])
  })

  test('读头像期间换号：连上传都不发（守 readAvatarPhoto 之后那处）', async () => {
    const effects = makeEffects()
    let key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const deps = makeDeps({
      effects,
      session: () => key,
      readAvatarPhoto: async () => {
        key = advanceSession(key, OTHER_OWNER)
        return PHOTO
      },
    })

    const outcome = await runProfileSave(input(), deps)

    expect(outcome).toEqual({ kind: 'aborted' })
    expect(effects.uploaded).toBe(0)
    expect(effects.patched).toEqual([])
  })

  test('上传期间换号：绝不发 PATCH、也不记下 objectKey（P1 的原现场）', async () => {
    const effects = makeEffects()
    let key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const deps = makeDeps({
      effects,
      session: () => key,
      uploadAvatar: async () => {
        // 头像正在直传时用户在另一处登录成了另一个账号
        effects.uploaded += 1
        key = advanceSession(key, OTHER_OWNER)
        return OBJECT_KEY
      },
    })

    const outcome = await runProfileSave(input(), deps)

    expect(outcome).toEqual({ kind: 'aborted' })
    // 上传本身无法撤回，但它的结果绝不能进入「已保存」这条路
    expect(effects.uploaded).toBe(1)
    expect(effects.uploadedKeys).toEqual([])
    expect(effects.patched).toEqual([])
  })

  test('迟到的保存任务：凭据已过期就不发 PATCH（守 patchProfile 之前那处）', async () => {
    const effects = makeEffects()
    // 任务是在上一代开的（ticket.epoch = 0），跑起来时页面已经清过场（epoch = 1）。
    // 这条路径不动头像，所以它是唯一一次、也是进入这条路径后唯一一次会话校验。
    const key: SessionKey = { ownerId: U1.id, epoch: 1 }
    const deps = makeDeps({ effects, session: () => key })

    const outcome = await runProfileSave(
      input({ draft: { nickname: '新昵称', avatarPath: null, uploaded: null } }),
      deps,
    )

    expect(outcome).toEqual({ kind: 'aborted' })
    expect(effects.uploaded).toBe(0)
    expect(effects.patched).toEqual([])
  })

  test('PATCH 已发出、响应回来时已换号：结果丢弃（守 patchProfile 之后那处）', async () => {
    const effects = makeEffects()
    let key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const deps = makeDeps({
      effects,
      session: () => key,
      patchProfile: async (body) => {
        effects.patched.push(body)
        key = advanceSession(key, OTHER_OWNER)
        return { ...U1, nickname: body.nickname ?? U1.nickname }
      },
    })

    const outcome = await runProfileSave(input(), deps)

    // 请求收不回，但页面绝不能拿它去弹成功 / 广播 / 返回
    expect(effects.patched).toHaveLength(1)
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  test('退出再登回同一账号：ownerId 没变、代次前进，旧任务照样作废', async () => {
    const effects = makeEffects()
    let key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const deps = makeDeps({
      effects,
      session: () => key,
      uploadAvatar: async () => {
        // 登出（ownerId → null）再登回同一账号：两代之间 epoch 已经推进
        key = advanceSession(key, null)
        key = advanceSession(key, U1.id)
        return OBJECT_KEY
      },
    })

    const outcome = await runProfileSave(input(), deps)

    expect(key.ownerId).toBe(U1.id)
    expect(outcome).toEqual({ kind: 'aborted' })
    expect(effects.patched).toEqual([])
  })

  test('页面卸载（代次前进、ownerId 不变）后在途任务作废', async () => {
    const effects = makeEffects()
    let key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const deps = makeDeps({
      effects,
      session: () => key,
      readAvatarPhoto: async () => {
        key = { ...key, epoch: key.epoch + 1 }
        return PHOTO
      },
    })

    const outcome = await runProfileSave(input(), deps)

    expect(outcome).toEqual({ kind: 'aborted' })
    expect(effects.uploaded).toBe(0)
    expect(effects.patched).toEqual([])
  })
})

describe('runProfileSave：失败与短路', () => {
  test('PATCH 抛错且会话未变：交给页面分类成文案', async () => {
    const effects = makeEffects()
    const key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const boom = new Error('nickname taken')
    const deps = makeDeps({
      effects,
      session: () => key,
      patchProfile: async () => {
        throw boom
      },
    })

    const outcome = await runProfileSave(input(), deps)

    expect(outcome).toEqual({ kind: 'failed', error: boom })
  })

  test('迟到的失败：换号后不再把旧账号的错误弹给新账号', async () => {
    const effects = makeEffects()
    let key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const deps = makeDeps({
      effects,
      session: () => key,
      patchProfile: async () => {
        key = advanceSession(key, OTHER_OWNER)
        throw new Error('nickname taken')
      },
    })

    const outcome = await runProfileSave(input(), deps)

    expect(outcome).toEqual({ kind: 'aborted' })
  })

  test('昵称预检不过：一个请求都不发', async () => {
    const effects = makeEffects()
    const key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const deps = makeDeps({ effects, session: () => key })

    const outcome = await runProfileSave(
      input({ draft: { nickname: '   ', avatarPath: PHOTO.path, uploaded: null } }),
      deps,
    )

    expect(outcome).toEqual({ kind: 'nickname-invalid', message: '请输入昵称' })
    expect(effects.uploaded).toBe(0)
    expect(effects.patched).toEqual([])
  })

  test('没有改动：不发必 422 的空 PATCH', async () => {
    const effects = makeEffects()
    const key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const deps = makeDeps({ effects, session: () => key })

    const outcome = await runProfileSave(
      input({ draft: { nickname: U1.nickname, avatarPath: null, uploaded: null } }),
      deps,
    )

    expect(outcome).toEqual({ kind: 'no-change' })
    expect(effects.patched).toEqual([])
  })

  test('头像已传过：不重复上传，直接用现成 objectKey', async () => {
    const effects = makeEffects()
    const key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const deps = makeDeps({ effects, session: () => key })

    const outcome = await runProfileSave(
      input({
        draft: {
          nickname: U1.nickname,
          avatarPath: PHOTO.path,
          uploaded: { path: PHOTO.path, objectKey: OBJECT_KEY },
        },
      }),
      deps,
    )

    expect(outcome).toEqual({
      kind: 'saved',
      ownerId: U1.id,
      nickname: U1.nickname,
      avatarUrl: null,
    })
    expect(effects.uploaded).toBe(0)
    expect(effects.patched).toEqual([{ avatarObjectKey: OBJECT_KEY }])
  })

  test('换过头像：旧 objectKey 不复用，重新上传', async () => {
    const effects = makeEffects()
    const key: SessionKey = { ownerId: U1.id, epoch: 0 }
    const newPath = 'wxfile://tmp_avatar_2.png'
    const deps = makeDeps({ effects, session: () => key })

    const outcome = await runProfileSave(
      input({
        draft: {
          nickname: U1.nickname,
          avatarPath: newPath,
          uploaded: { path: PHOTO.path, objectKey: 'users/u1/avatar/old.png' },
        },
      }),
      deps,
    )

    expect(outcome).toEqual({
      kind: 'saved',
      ownerId: U1.id,
      nickname: U1.nickname,
      avatarUrl: null,
    })
    expect(effects.uploaded).toBe(1)
    expect(effects.uploadedKeys).toEqual([{ path: newPath, objectKey: OBJECT_KEY }])
    expect(effects.patched).toEqual([{ avatarObjectKey: OBJECT_KEY }])
  })
})

describe('会话代次本身', () => {
  test('ownerId 不变就不前进代次（避免每次渲染都作废在途任务）', () => {
    const key: SessionKey = { ownerId: U1.id, epoch: 3 }
    expect(advanceSession(key, U1.id)).toBe(key)
  })

  test('换号、登出、登入都会前进代次', () => {
    const key: SessionKey = { ownerId: U1.id, epoch: 3 }
    expect(advanceSession(key, OTHER_OWNER)).toEqual({ ownerId: OTHER_OWNER, epoch: 4 })
    expect(advanceSession(key, null)).toEqual({ ownerId: null, epoch: 4 })
    expect(advanceSession({ ownerId: null, epoch: 4 }, U1.id)).toEqual({ ownerId: U1.id, epoch: 5 })
  })

  test('带任务号的凭据按 ownerId + 代次判断，任务号不参与', () => {
    const key: SessionKey = { ownerId: U1.id, epoch: 3 }
    expect(isTicketCurrent({ ...key, id: 1 }, key)).toBe(true)
    expect(isTicketCurrent({ ...key, id: 99 }, key)).toBe(true)
    expect(isTicketCurrent({ ...key, id: 1 }, { ownerId: OTHER_OWNER, epoch: 3 })).toBe(false)
    expect(isTicketCurrent({ ...key, id: 1 }, { ownerId: U1.id, epoch: 4 })).toBe(false)
  })
})

describe('SaveOutcome 穷尽性', () => {
  test('每个分支都有 kind 判别字段', () => {
    const outcomes: SaveOutcome[] = [
      { kind: 'saved', ownerId: U1.id, nickname: 'n', avatarUrl: null },
      { kind: 'aborted' },
      { kind: 'no-change' },
      { kind: 'nickname-invalid', message: '请输入昵称' },
      { kind: 'failed', error: new Error('x') },
    ]
    expect(new Set(outcomes.map((outcome) => outcome.kind)).size).toBe(5)
  })
})
