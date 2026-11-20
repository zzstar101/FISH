import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import {
  findLegacyMediaAuditItem,
  type LegacyMediaDecision,
  requeueFailedLegacyMediaAudit,
  syncLegacyMediaInventory,
} from '@fish/db/legacy-media-audit'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { WorkerMediaReadError } from '../../media-storage'
import { InvalidJobPayloadError } from '../invalid-payload-error'
import { runLegacyMediaAudit } from './handlers'
import { LegacyMediaAuditModerationError, type LegacyMediaAuditModerator } from './moderator'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_legacy_media_handler_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()
const migrationsFolder = new URL('../../../../../packages/db/src/migrations', import.meta.url)
  .pathname

const adminDb = createDb(databaseUrl)
let db: Db

const SELLER_ID = '01930000-0000-4000-8000-000000000701'
const LISTING_ID = '01930000-0000-4000-8000-000000000702'
const ALLOW_KEY = 'listings/01930000-0000-4000-8000-0000000007a1/allow.png'
const FAIL_KEY = 'listings/01930000-0000-4000-8000-0000000007a2/fail.png'
const BLOCK_KEY = 'listings/01930000-0000-4000-8000-0000000007a3/block.png'
const OVERSIZED_KEY = 'listings/01930000-0000-4000-8000-0000000007a4/oversized.png'
const TRANSIENT_KEY = 'listings/01930000-0000-4000-8000-0000000007a5/transient.png'
const RETRY_KEY = 'listings/01930000-0000-4000-8000-0000000007a6/retry.png'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function moderationResult(decision: LegacyMediaDecision) {
  return {
    decision,
    provider: 'LOCAL',
    providerRequestId: null,
    policyVersion: 'test-policy',
    suggestion: decision === 'ALLOW' ? 'Pass' : decision === 'REVIEW' ? 'Review' : 'Block',
    label: null,
    subLabel: null,
    score: null,
    contentDigest: null,
  } as const
}

beforeAll(async () => {
  await adminDb.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await adminDb.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })

  await db.insert(users).values({ id: SELLER_ID, nickname: '卖家' })
  const listingNo = await reserveTestListingNo(db, LISTING_ID)
  await db.insert(listings).values({
    id: LISTING_ID,
    listingNo,
    sellerId: SELLER_ID,
    title: '商品',
    description: '描述',
    priceCents: 100,
    category: 'OTHER',
    condition: 'GOOD',
  })
  await db.insert(listingImages).values([
    { listingId: LISTING_ID, objectKey: ALLOW_KEY, sortOrder: 0 },
    { listingId: LISTING_ID, objectKey: FAIL_KEY, sortOrder: 1 },
    { listingId: LISTING_ID, objectKey: BLOCK_KEY, sortOrder: 2 },
    { listingId: LISTING_ID, objectKey: OVERSIZED_KEY, sortOrder: 3 },
    { listingId: LISTING_ID, objectKey: TRANSIENT_KEY, sortOrder: 4 },
    { listingId: LISTING_ID, objectKey: RETRY_KEY, sortOrder: 5 },
  ])
  await syncLegacyMediaInventory(db)
})

afterAll(async () => {
  if (db) await db.$client.close()
  await adminDb.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await adminDb.$client.close()
})

function deps(moderator: LegacyMediaAuditModerator) {
  if (!db) throw new Error('db 未初始化')
  return {
    db,
    moderator,
    storage: { readBytes: async () => PNG_BYTES },
    maxImageBytes: 1_000_000,
    maxAttempts: 3,
    retryDelayMs: 0,
  }
}

describe('legacy media audit handler', () => {
  test('ALLOW 落库并保持商品公开；重复处理不重复建记录、结论稳定', async () => {
    let calls = 0
    const moderator: LegacyMediaAuditModerator = async () => {
      calls += 1
      return moderationResult('ALLOW')
    }

    const first = await runLegacyMediaAudit(deps(moderator), { objectKey: ALLOW_KEY })
    expect(first).toEqual({ status: 'audited', decision: 'ALLOW', listingsAffected: 0 })
    expect(calls).toBe(1)

    const item = await findLegacyMediaAuditItem(db, ALLOW_KEY)
    expect(item?.auditStatus).toBe('AUDITED')
    expect(item?.decision).toBe('ALLOW')
    expect(item?.attempts).toBe(1)

    const second = await runLegacyMediaAudit(deps(moderator), { objectKey: ALLOW_KEY })
    expect(second).toEqual({ status: 'already_audited' })
    expect(calls).toBe(1)

    const [row] = await db
      .select({ moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.id, LISTING_ID))
    expect(row?.moderationStatus).toBe('APPROVED')
  })

  test('超过配置读取上限的对象不送审，按不可重试失败收口', async () => {
    let calls = 0
    const moderator: LegacyMediaAuditModerator = async () => {
      calls += 1
      return moderationResult('ALLOW')
    }
    const outcome = await runLegacyMediaAudit(
      {
        ...deps(moderator),
        storage: { readBytes: async () => new Uint8Array(1_000_001) },
      },
      { objectKey: OVERSIZED_KEY },
    )
    expect(outcome).toMatchObject({ status: 'failed', reason: 'image_too_large', retryable: false })
    expect(calls).toBe(0)
  })

  test('上游失败不改可见性，保留 PENDING 等下一轮；恢复后正常出结论', async () => {
    const failing: LegacyMediaAuditModerator = async () => {
      throw new LegacyMediaAuditModerationError('upstream timeout', { retryable: true })
    }
    const failed = await runLegacyMediaAudit(deps(failing), { objectKey: FAIL_KEY })
    expect(failed).toMatchObject({ status: 'failed', retryable: true, attempts: 1 })

    const pending = await findLegacyMediaAuditItem(db, FAIL_KEY)
    expect(pending?.auditStatus).toBe('PENDING')
    expect(pending?.decision).toBeNull()

    const [row] = await db
      .select({ moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.id, LISTING_ID))
    expect(row?.moderationStatus).toBe('APPROVED')

    const recovered = await runLegacyMediaAudit(
      deps(async () => moderationResult('ALLOW')),
      { objectKey: FAIL_KEY },
    )
    expect(recovered).toEqual({ status: 'audited', decision: 'ALLOW', listingsAffected: 0 })
  })

  test('BLOCK 收口公开可见性', async () => {
    const blocked = await runLegacyMediaAudit(
      deps(async () => moderationResult('BLOCK')),
      { objectKey: BLOCK_KEY },
    )
    expect(blocked).toEqual({ status: 'audited', decision: 'BLOCK', listingsAffected: 1 })

    const [row] = await db
      .select({ moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.id, LISTING_ID))
    expect(row?.moderationStatus).toBe('BLOCKED')
  })

  test('读存储瞬时失败按可重试收口，下一轮成功出结论', async () => {
    const transient = await runLegacyMediaAudit(
      {
        ...deps(async () => moderationResult('ALLOW')),
        storage: {
          readBytes: async () => {
            throw new WorkerMediaReadError('读取对象失败：socket timeout', {
              cause: new Error('socket timeout'),
            })
          },
        },
      },
      { objectKey: TRANSIENT_KEY },
    )
    expect(transient).toMatchObject({
      status: 'failed',
      reason: 'storage_read_failed',
      retryable: true,
      attempts: 1,
    })

    const pending = await findLegacyMediaAuditItem(db, TRANSIENT_KEY)
    expect(pending?.auditStatus).toBe('PENDING')

    const recovered = await runLegacyMediaAudit(
      deps(async () => moderationResult('ALLOW')),
      { objectKey: TRANSIENT_KEY },
    )
    expect(recovered).toEqual({ status: 'audited', decision: 'ALLOW', listingsAffected: 0 })
  })

  test('FAILED 记录可被 CLI 重排为 PENDING 并再次处理', async () => {
    const failed = await runLegacyMediaAudit(
      {
        ...deps(async () => {
          throw new LegacyMediaAuditModerationError('unsupported', { retryable: false })
        }),
      },
      { objectKey: RETRY_KEY },
    )
    expect(failed).toMatchObject({ status: 'failed', retryable: false })

    const dead = await findLegacyMediaAuditItem(db, RETRY_KEY)
    expect(dead?.auditStatus).toBe('FAILED')

    const requeued = await requeueFailedLegacyMediaAudit(db, { limit: 10 })
    expect(requeued.requeued).toBeGreaterThanOrEqual(1)

    const revived = await findLegacyMediaAuditItem(db, RETRY_KEY)
    expect(revived?.auditStatus).toBe('PENDING')
    expect(revived?.attempts).toBe(0)
    expect(revived?.lastError).toBeNull()

    const processed = await runLegacyMediaAudit(
      deps(async () => moderationResult('ALLOW')),
      { objectKey: RETRY_KEY },
    )
    expect(processed).toEqual({ status: 'audited', decision: 'ALLOW', listingsAffected: 0 })
  })

  test('未盘点的对象返回 missing；坏 payload 是 fatal 错误', async () => {
    const result = await runLegacyMediaAudit(
      deps(async () => moderationResult('ALLOW')),
      { objectKey: 'listings/01930000-0000-4000-8000-0000000007ff/missing.png' },
    )
    expect(result).toEqual({ status: 'missing' })

    await expect(
      runLegacyMediaAudit(
        deps(async () => moderationResult('ALLOW')),
        {},
      ),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError)
  })
})
