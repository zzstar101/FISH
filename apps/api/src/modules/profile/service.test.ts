import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { UserRow } from '../auth/me'
import { ContentModerationError } from '../moderation/providers/types'
import { type UploadService, UploadServiceError } from '../uploads/service'
import type { MediaStorage } from '../uploads/storage'
import type { ProfileModerationPolicy, ProfileTextModerationResult } from './moderation-policy'
import type { ProfileChange, ProfileModerationRecordInput } from './moderation-store'
import { createProfileService, PROFILE_LIST_LIMIT, ProfileServiceError } from './service'
import type {
  ProfileListingRow,
  ProfilePendingRow,
  ProfileStatsRow,
  ProfileStore,
  ProfileTransactionRow,
  ProfileWishRow,
} from './store'

const USER_ID = '01930000-0000-7000-8000-0000000000a1'
const me: Me = {
  id: encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID),
  uid: '1000000001',
  nickname: '小明',
  avatarUrl: null,
  authStatus: 'VERIFIED',
  verifiedAt: '2026-09-12T00:00:00.000Z',
  phoneBound: false,
  maskedPhone: null,
  signature: null,
}

const storage: MediaStorage = {
  presignPut: () => ({ url: '', headers: {}, expiresAt: '' }),
  stat: async () => null,
  publicUrl: (key) => `https://cdn.test/${key}`,
}

/**
 * #86 B：改头像必须复用上传域的 `confirm`（归属前缀 + 对象已上传 + 格式/大小）。
 * 读用例不碰它；写用例要断言「服务端拼的是 confirm 给的 URL，而不是端上给的字符串」，
 * 所以这里给一个能记录调用的假实现（真实现要求 storage.stat 有对象，本文件不搭 S3）。
 *
 * #286 复审 blocker 2 之后 `confirm` 还会回传**有效**审核结论：只有机器 `ALLOW` 才允许把地址写进
 * 公开的 `avatarUrl`，所以这里默认给 `ALLOW`，需要验证 fail-closed 的用例显式传 `REVIEW`/`BLOCK`。
 */
function fakeUploads(
  decision: 'ALLOW' | 'REVIEW' | 'BLOCK' = 'ALLOW',
): Pick<UploadService, 'confirm'> & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async confirm(_userId, input) {
      calls.push(input.objectKey)
      return {
        objectKey: input.objectKey,
        url: `https://cdn.test/${input.objectKey}`,
        moderationDecision: decision,
      }
    },
  }
}

/** `users` 行 fixture：写用例要断言 DB 行 → Me 的映射仍走认证域的 toMe。 */
const userRow = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: USER_ID,
  uid: '1000000001',
  nickname: '小明',
  avatarUrl: null,
  // #287：users 新增可空 signature 列，fixture 补默认值。
  signature: null,
  authStatus: 'VERIFIED',
  verifiedAt: new Date('2026-09-12T00:00:00.000Z'),
  campusEmail: null,
  phone: null,
  role: 'USER',
  // #464：users 新增账号注销三列，fixture 补默认值（ACTIVE = 从未申请注销）。
  accountStatus: 'ACTIVE',
  deletionRequestedAt: null,
  purgeScheduledAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-12T00:00:00.000Z'),
  ...overrides,
})

const listingRow = (overrides: Partial<ProfileListingRow> = {}): ProfileListingRow => ({
  id: '01930000-0000-7000-8000-0000000000b1',
  listingNo: 123456789012n,
  title: 'K380',
  priceCents: 16000,
  category: 'DIGITAL',
  condition: 'GOOD',
  status: 'OFFLINE', // 本人视角可见非在售
  urgent: false,
  negotiable: true,
  free: false,
  createdAt: new Date('2026-09-12T01:00:00.000Z'),
  coverObjectKey: 'covers/a.jpg',
  // #191：卡片卖家公开子集（本人视角 = 查看者自己），join users 同源带出。
  seller: { id: USER_ID, nickname: '小明', avatarUrl: null, authStatus: 'VERIFIED' },
  // 想要数（已建会话的买家数）：卡片契约的必填字段，fake 行给 0（本用例不关心它）。
  wants: 0,
  views: 0,
  ...overrides,
})

const wishRow = (overrides: Partial<ProfileWishRow> = {}): ProfileWishRow => ({
  id: '01930000-0000-7000-8000-0000000000d1',
  user_id: USER_ID,
  keyword: '机械键盘',
  category: 'DIGITAL',
  budget_min_cents: 10000,
  budget_max_cents: 20000,
  description: null,
  accept_similar: true,
  status: 'ACTIVE',
  match_count: 2,
  created_at: '2026-09-12T02:00:00.000Z',
  updated_at: '2026-09-12T02:00:00.000Z',
  ...overrides,
})

const txRow = (overrides: Partial<ProfileTransactionRow> = {}): ProfileTransactionRow => ({
  id: '01930000-0000-7000-8000-0000000000e1',
  listingId: listingRow().id,
  buyerId: USER_ID, // 我是买家 → role=buyer
  amountCents: 15000,
  status: 'COMPLETED',
  createdAt: '2026-09-12T03:00:00.000Z',
  listing: {
    title: 'K380 键盘',
    priceCents: 16000,
    status: 'SOLD',
    coverObjectKey: 'covers/tx.jpg',
  },
  counterpart: {
    id: '01930000-0000-7000-8000-0000000000a2',
    nickname: '卖家小王',
    avatarUrl: null,
  },
  ...overrides,
})

/** #694 M5：待审记录 → 本人视图的 fixture（`payload` 只含本次变化的列）。 */
const pendingRow = (
  payload: ProfileChange,
  submittedAt = new Date('2026-09-12T04:00:00.000Z'),
): ProfilePendingRow => ({ payload, submittedAt })

class MemoryProfileStore implements ProfileStore {
  statsRow: ProfileStatsRow = {
    activeListings: 1,
    activeWishes: 1,
    completedTransactions: 1,
    followingCount: 2,
  }
  lastStatsUserId: string | null = null
  listings: ProfileListingRow[] = [listingRow()]
  wishes: ProfileWishRow[] = [wishRow()]
  transactions: ProfileTransactionRow[] = [txRow()]
  pending: ProfilePendingRow | null = null
  /** `applyProfileChange` 收到的最后一次写入（写用例断言「只写了该写的列」）。 */
  applied: {
    userId: string
    change: ProfileChange
    options: { supersedePending: boolean }
  } | null = null
  /** `queuePendingProfileChange` 收到的最后一次挂起。 */
  queued: {
    userId: string
    change: ProfileChange
    record: ProfileModerationRecordInput
  } | null = null
  /** 覆盖 `applyProfileChange` 的返回行；null 模拟「认证与写入之间账号被删」。 */
  applyResult: UserRow | null | undefined = undefined
  /** 覆盖 `queuePendingProfileChange` 的返回值；null 模拟账号已不存在。 */
  queueResult: ProfilePendingRow | null | undefined = undefined

  async stats(userId: string): Promise<ProfileStatsRow> {
    this.lastStatsUserId = userId
    return this.statsRow
  }
  async ownListings(_userId: string, limit: number) {
    return this.listings.slice(0, limit)
  }
  async ownWishes(_userId: string, limit: number) {
    return this.wishes.slice(0, limit)
  }
  async ownTransactions(_userId: string, limit: number) {
    return this.transactions.slice(0, limit)
  }
  async findPendingProfileChange(_userId: string) {
    return this.pending
  }
  async applyProfileChange(
    userId: string,
    change: ProfileChange,
    options: { supersedePending: boolean },
  ) {
    this.applied = { userId, change, options }
    if (options.supersedePending) this.pending = null
    if (this.applyResult !== undefined) return this.applyResult
    return userRow({
      id: userId,
      ...(change.nickname === undefined ? {} : { nickname: change.nickname }),
      ...(change.avatarUrl === undefined ? {} : { avatarUrl: change.avatarUrl }),
      ...(change.signature === undefined ? {} : { signature: change.signature }),
    })
  }
  async queuePendingProfileChange(
    userId: string,
    change: ProfileChange,
    record: ProfileModerationRecordInput,
  ) {
    this.queued = { userId, change, record }
    if (this.queueResult !== undefined) return this.queueResult
    this.pending = pendingRow(change)
    return this.pending
  }
}

/**
 * #694 M5：资料文本审核策略的假实现。真实现的 BizType / provider 映射由装配处决定，
 * 这里只回一个可编排的结论，让 service 的分支（ALLOW / BLOCK / REVIEW / 上游故障）都可测。
 */
function fakeModeration(
  decision: 'ALLOW' | 'BLOCK' | 'REVIEW' = 'ALLOW',
  overrides: Partial<ProfileTextModerationResult> = {},
): ProfileModerationPolicy & { calls: { nickname?: string; signature?: string }[] } {
  const calls: { nickname?: string; signature?: string }[] = []
  return {
    calls,
    async moderateProfile(input) {
      calls.push(input)
      return {
        decision,
        provider: 'LOCAL',
        policyVersion: 'local-v1',
        providerRequestId: null,
        suggestion: decision === 'ALLOW' ? 'Pass' : decision === 'BLOCK' ? 'Block' : 'Review',
        label: null,
        subLabel: decision === 'ALLOW' ? null : 'PUBLIC_EXTERNAL_CONTACT',
        score: null,
        matchedRules: decision === 'ALLOW' ? [] : ['PUBLIC_EXTERNAL_CONTACT'],
        matchedTermsMasked: [],
        blockedFields: [],
        ...overrides,
      }
    },
  }
}

/** 读用例的统一装配（#86 B 起多一个必填的 uploads 依赖，#694 M5 再多一个审核策略）。 */
const createService = (
  store: ProfileStore,
  uploads: Pick<UploadService, 'confirm'> = fakeUploads(),
  moderation: ProfileModerationPolicy = fakeModeration(),
) => createProfileService({ store, storage, uploads, moderation })

describe('profile service: getProfile', () => {
  test('aggregates user + stats + three lists in one call', async () => {
    const store = new MemoryProfileStore()
    const service = createService(store)
    const profile = await service.getProfile(me)

    expect(store.lastStatsUserId).toBe(USER_ID)
    expect(profile.user).toEqual(me) // user 块原样来自 requireAuth 的 Me
    expect(profile.stats).toEqual({
      activeListings: 1,
      activeWishes: 1,
      completedTransactions: 1,
      followingCount: 2,
    })
    // 商品卡：封面 objectKey 经 storage 拼 URL；本人可见 OFFLINE
    expect(profile.listings[0]?.coverUrl).toBe('https://cdn.test/covers/a.jpg')
    expect(profile.listings[0]?.status).toBe('OFFLINE')
    // 愿望：snake_case 行经 wishes 模块同一映射函数转 DTO
    expect(profile.wishes[0]?.matchCount).toBe(2)
    expect(profile.wishes[0]?.keyword).toBe('机械键盘')
    // 交易：我是 buyer → role=buyer；订单卡摘要内嵌商品与对方（coverUrl 由 storage 拼）
    expect(profile.transactions[0]?.role).toBe('buyer')
    expect(profile.transactions[0]?.listing).toEqual({
      id: encodePublicId(PUBLIC_ID_PREFIX.listing, listingRow().id),
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'SOLD',
      coverUrl: 'https://cdn.test/covers/tx.jpg',
    })
    expect(profile.transactions[0]?.counterpart).toMatchObject({ nickname: '卖家小王' })
  })

  test('transaction row missing embedded summary is skipped (决策 C)', async () => {
    const store = new MemoryProfileStore()
    store.transactions = [txRow({ listing: null, counterpart: null })]
    const service = createService(store)
    const profile = await service.getProfile(me)
    expect(profile.transactions).toHaveLength(0)
  })

  test('transaction role is seller when I am not the buyer', async () => {
    const store = new MemoryProfileStore()
    store.transactions = [txRow({ buyerId: '01930000-0000-7000-8000-0000000000a2' })]
    const service = createService(store)
    const profile = await service.getProfile(me)
    expect(profile.transactions[0]?.role).toBe('seller')
  })

  test('limit is applied to each list (封顶 100)', async () => {
    const store = new MemoryProfileStore()
    store.listings = Array.from({ length: PROFILE_LIST_LIMIT + 10 }, (_, i) =>
      listingRow({ id: `01930000-0000-7000-8000-${String(i + 1).padStart(12, '0')}` }),
    )
    const service = createService(store)
    const profile = await service.getProfile(me)
    expect(profile.listings).toHaveLength(PROFILE_LIST_LIMIT)
  })

  test('counterpart.avatarUrl 的脏值降级为 null，合法 URL 原样保留', async () => {
    const dirty = new MemoryProfileStore()
    dirty.transactions = [
      txRow({
        counterpart: {
          id: '01930000-0000-7000-8000-0000000000a2',
          nickname: '卖家小王',
          // #2 的 users.avatar_url 是无约束 text：object key 这类历史值不符合契约的 z.url()
          avatarUrl: 'listings/avatar.jpg',
        },
      }),
    ]
    // 修复前：z.url() 解析失败 → 整个聚合抛 ZodError（一个脏字段让 /profile 全打不开）
    const dirtyProfile = await createService(dirty).getProfile(me)
    expect(dirtyProfile.transactions).toHaveLength(1)
    expect(dirtyProfile.transactions[0]?.counterpart.avatarUrl).toBeNull()

    const clean = new MemoryProfileStore()
    clean.transactions = [
      txRow({
        counterpart: {
          id: '01930000-0000-7000-8000-0000000000a2',
          nickname: '卖家小王',
          avatarUrl: 'https://cdn.test/avatars/a2.jpg',
        },
      }),
    ]
    const cleanProfile = await createService(clean).getProfile(me)
    expect(cleanProfile.transactions[0]?.counterpart.avatarUrl).toBe(
      'https://cdn.test/avatars/a2.jpg',
    )
  })

  test('null cover renders as null URL', async () => {
    const store = new MemoryProfileStore()
    store.listings = [listingRow({ coverObjectKey: null })]
    const service = createService(store)
    const profile = await service.getProfile(me)
    expect(profile.listings[0]?.coverUrl).toBeNull()
  })

  // #694 M5：待审新值只回给本人，且**不进任何公开投射**（列表 / 商品卡 / 订单对方）。
  test('待审资料只出现在 pending 里，列表与卡片仍是旧公开值', async () => {
    const store = new MemoryProfileStore()
    store.pending = pendingRow({ nickname: '待审昵称', avatarUrl: 'https://cdn.test/new.jpg' })
    const profile = await createService(store).getProfile(me)

    expect(profile.user.nickname).toBe('小明')
    expect(profile.pending).toEqual({
      nickname: '待审昵称',
      signature: null,
      avatarUrl: 'https://cdn.test/new.jpg',
      fields: ['nickname', 'avatarUrl'],
      submittedAt: '2026-09-12T04:00:00.000Z',
    })
    expect(profile.listings[0]?.seller?.nickname).toBe('小明')
    expect(profile.transactions[0]?.counterpart.nickname).toBe('卖家小王')
  })

  test('没有待审记录时 pending 为 null', async () => {
    const profile = await createService(new MemoryProfileStore()).getProfile(me)
    expect(profile.pending).toBeNull()
  })
})

describe('profile service: updateProfile（#86 B：编辑资料）', () => {
  test('只改昵称：只写 nickname 一列，不碰头像、不碰上传域', async () => {
    const store = new MemoryProfileStore()
    const uploads = fakeUploads()
    const { user } = await createService(store, uploads).updateProfile(me, { nickname: '新名字' })

    expect(store.applied).toEqual({
      userId: USER_ID,
      change: { nickname: '新名字' },
      options: { supersedePending: true },
    })
    expect(uploads.calls).toEqual([])
    expect(user.nickname).toBe('新名字')
    expect(user.avatarUrl).toBeNull()
  })

  test('签名（#179）：原文落库、空白串归一化为 null（清空）', async () => {
    const store = new MemoryProfileStore()
    const { user } = await createService(store).updateProfile(me, {
      signature: '  面交优先，可小刀  ',
    })

    expect(store.applied?.change).toEqual({ signature: '面交优先，可小刀' })
    expect(user.signature).toBe('面交优先，可小刀')
  })

  test('签名（#179）：只传空白 = 清空，change.signature 是 null', async () => {
    const store = new MemoryProfileStore()
    // 已经为 null 的签名再清空是空操作（不写库），所以这里必须先有旧值。
    const { user } = await createService(store).updateProfile(
      { ...me, signature: '旧签名' },
      { signature: '   ' },
    )

    expect(store.applied?.change).toEqual({ signature: null })
    expect(user.signature).toBeNull()
  })

  test('签名（#179）：不传 signature 就不碰该列', async () => {
    const store = new MemoryProfileStore()
    await createService(store).updateProfile(me, { nickname: '新名字' })
    expect(Object.hasOwn(store.applied?.change ?? {}, 'signature')).toBe(false)
  })

  test('只改头像：objectKey 交给上传域 confirm，落库的是它给的绝对 URL', async () => {
    const store = new MemoryProfileStore()
    const uploads = fakeUploads()
    const { user } = await createService(store, uploads).updateProfile(me, {
      avatarObjectKey: 'listings/u1/a.jpg',
    })

    expect(uploads.calls).toEqual(['listings/u1/a.jpg'])
    expect(store.applied?.change).toEqual({ avatarUrl: 'https://cdn.test/listings/u1/a.jpg' })
    // 只改头像没有文本过审，不能顺手撤掉用户更早的待审昵称。
    expect(store.applied?.options).toEqual({ supersedePending: false })
    expect(user.avatarUrl).toBe('https://cdn.test/listings/u1/a.jpg')
  })

  test('两项一起改：一次 update 同时落 nickname 与 avatarUrl', async () => {
    const store = new MemoryProfileStore()
    const { user } = await createService(store).updateProfile(me, {
      nickname: '新名字',
      avatarObjectKey: 'listings/u1/a.jpg',
    })

    expect(store.applied?.change).toEqual({
      nickname: '新名字',
      avatarUrl: 'https://cdn.test/listings/u1/a.jpg',
    })
    expect(user).toMatchObject({
      id: me.id,
      nickname: '新名字',
      avatarUrl: 'https://cdn.test/listings/u1/a.jpg',
    })
  })

  test('写入与认证之间账号被删：applyProfileChange 回 null 时抛错，不返回假 Me', async () => {
    const store = new MemoryProfileStore()
    store.applyResult = null

    await expect(createService(store).updateProfile(me, { nickname: '新名字' })).rejects.toThrow(
      '更新资料时账号已不存在',
    )
  })

  test('上传域拒绝（不属于本人 / 对象缺失 / 格式大小）原样冒泡，不写库', async () => {
    const store = new MemoryProfileStore()
    const rejected: Pick<UploadService, 'confirm'> = {
      confirm: async () => {
        throw new Error('IMAGE_REFERENCE_INVALID')
      },
    }

    await expect(
      createService(store, rejected).updateProfile(me, { avatarObjectKey: 'listings/u2/b.jpg' }),
    ).rejects.toThrow('IMAGE_REFERENCE_INVALID')
    expect(store.applied).toBeNull()
  })

  // #286 复审 blocker 2：REVIEW 的头像固化在**私有**前缀、BLOCK 的头像根本不固化，两者都不可能
  // 进公开的 `avatarUrl`。头像没有人工审核队列，所以只能 fail-closed：接口 422，库里旧头像不变。
  test('审核未通过的头像 fail-closed：422 IMAGE_CONTENT_BLOCKED，不写库', async () => {
    for (const decision of ['REVIEW', 'BLOCK'] as const) {
      const store = new MemoryProfileStore()
      const uploads = fakeUploads(decision)

      const caught = await createService(store, uploads)
        .updateProfile(me, { avatarObjectKey: 'listing-review-media/u1/a.jpg' })
        .then(
          () => null,
          (error: unknown) => error,
        )

      expect(caught).toBeInstanceOf(UploadServiceError)
      if (!(caught instanceof UploadServiceError)) throw caught
      expect(caught.status).toBe(422)
      expect(caught.code).toBe('IMAGE_CONTENT_BLOCKED')
      expect(caught.details).toEqual([
        { field: 'avatarObjectKey', message: '头像未通过审核，请更换图片' },
      ])
      expect(uploads.calls).toEqual(['listing-review-media/u1/a.jpg'])
      expect(store.applied).toBeNull()
    }
  })
})

describe('profile service: updateProfile（#694 M5 公开 UGC 审核）', () => {
  test('只送审本次变化的字段：昵称没变就只审签名', async () => {
    const store = new MemoryProfileStore()
    const moderation = fakeModeration()
    await createService(store, fakeUploads(), moderation).updateProfile(me, {
      nickname: me.nickname,
      signature: '新签名',
    })

    expect(moderation.calls).toEqual([{ signature: '新签名' }])
  })

  test('BLOCK：422 PROFILE_CONTENT_BLOCKED，只报被 BLOCK 的字段，公开值一个都不改', async () => {
    const store = new MemoryProfileStore()
    const uploads = fakeUploads()
    const moderation = fakeModeration('BLOCK', {
      blockedFields: ['signature'],
      matchedRules: ['PROHIBITED_CONTENT'],
    })

    const caught = await createService(store, uploads, moderation)
      .updateProfile(me, {
        nickname: '新名字',
        signature: '加微信 123456',
        avatarObjectKey: 'listings/u1/a.jpg',
      })
      .then(
        () => null,
        (error: unknown) => error,
      )

    expect(caught).toBeInstanceOf(ProfileServiceError)
    if (!(caught instanceof ProfileServiceError)) throw caught
    expect(caught.status).toBe(422)
    expect(caught.code).toBe('PROFILE_CONTENT_BLOCKED')
    expect(caught.details).toEqual([
      { field: 'signature', message: '个性签名包含平台禁止发布的内容' },
    ])
    // fail-closed 的关键：文本没过审时连头像都不 confirm（否则私有固化 + 旧值不动也算部分提交）
    expect(uploads.calls).toEqual([])
    expect(store.applied).toBeNull()
    expect(store.queued).toBeNull()
  })

  test('上游审核不可用：503 CONTENT_MODERATION_UNAVAILABLE，不降级放行也不写库', async () => {
    const store = new MemoryProfileStore()
    const moderation: ProfileModerationPolicy = {
      moderateProfile: async () => {
        throw new ContentModerationError({ reason: 'timeout', provider: 'TENCENT_TMS' })
      },
    }

    const caught = await createService(store, fakeUploads(), moderation)
      .updateProfile(me, { nickname: '新名字' })
      .then(
        () => null,
        (error: unknown) => error,
      )

    expect(caught).toBeInstanceOf(ProfileServiceError)
    if (!(caught instanceof ProfileServiceError)) throw caught
    expect(caught.status).toBe(503)
    expect(caught.code).toBe('CONTENT_MODERATION_UNAVAILABLE')
    expect(store.applied).toBeNull()
    expect(store.queued).toBeNull()
  })

  test('REVIEW：落待审并保留旧公开值，头像与文本一起挂起（放行时一次性切换）', async () => {
    const store = new MemoryProfileStore()
    const moderation = fakeModeration('REVIEW')
    const { user, pending } = await createService(store, fakeUploads(), moderation).updateProfile(
      me,
      { nickname: '待审昵称', signature: '待审签名', avatarObjectKey: 'listings/u1/a.jpg' },
    )

    // 公开值不动：user 仍是 requireAuth 给的旧 Me
    expect(user).toEqual(me)
    expect(store.applied).toBeNull()
    expect(store.queued?.change).toEqual({
      nickname: '待审昵称',
      signature: '待审签名',
      avatarUrl: 'https://cdn.test/listings/u1/a.jpg',
    })
    // 审核结论原样进待审记录（人工队列要看到机审档位与命中规则）
    expect(store.queued?.record).toMatchObject({
      machineDecision: 'REVIEW',
      decision: 'REVIEW',
      provider: 'LOCAL',
      policyVersion: 'local-v1',
      matchedRules: ['PUBLIC_EXTERNAL_CONTACT'],
    })
    expect(pending).toEqual({
      nickname: '待审昵称',
      signature: '待审签名',
      avatarUrl: 'https://cdn.test/listings/u1/a.jpg',
      fields: ['nickname', 'signature', 'avatarUrl'],
      submittedAt: '2026-09-12T04:00:00.000Z',
    })
  })

  test('REVIEW 但账号已不存在：queuePendingProfileChange 回 null 时抛错', async () => {
    const store = new MemoryProfileStore()
    store.queueResult = null

    await expect(
      createService(store, fakeUploads(), fakeModeration('REVIEW')).updateProfile(me, {
        nickname: '待审昵称',
      }),
    ).rejects.toThrow('更新资料时账号已不存在')
  })

  test('提交值与当前公开值完全一致：不写库、不送审，原样回当前待审状态', async () => {
    const store = new MemoryProfileStore()
    store.pending = pendingRow({ nickname: '更早的待审昵称' })
    const moderation = fakeModeration()
    const uploads = fakeUploads()

    const { user, pending } = await createService(store, uploads, moderation).updateProfile(me, {
      nickname: me.nickname,
    })

    expect(moderation.calls).toEqual([])
    expect(uploads.calls).toEqual([])
    expect(store.applied).toBeNull()
    expect(store.queued).toBeNull()
    expect(user).toEqual(me)
    expect(pending?.nickname).toBe('更早的待审昵称')
  })

  test('ALLOW：直接生效并取代更早的待审，pending 归零', async () => {
    const store = new MemoryProfileStore()
    store.pending = pendingRow({ nickname: '更早的待审昵称' })
    const { user, pending } = await createService(store).updateProfile(me, { nickname: '新名字' })

    expect(store.applied?.options).toEqual({ supersedePending: true })
    expect(store.queued).toBeNull()
    expect(user.nickname).toBe('新名字')
    expect(pending).toBeNull()
  })
})
