import { describe, expect, test } from 'bun:test'
import {
  AdminAuditLogEntrySchema,
  AdminListingDetailSchema,
  AdminMeResponseSchema,
  AdminOverviewSchema,
  AdminUserSummaryPageSchema,
  maskStudentNo,
  UserRoleSchema,
} from './schema'

describe('UserRoleSchema', () => {
  test('accepts USER and ADMIN', () => {
    expect(UserRoleSchema.parse('USER')).toBe('USER')
    expect(UserRoleSchema.parse('ADMIN')).toBe('ADMIN')
  })

  test('rejects unknown roles', () => {
    expect(UserRoleSchema.safeParse('SUPER_ADMIN').success).toBe(false)
  })
})

describe('maskStudentNo', () => {
  test('masks the middle of a 12-digit student no', () => {
    expect(maskStudentNo('202101000001')).toBe('2021****0001')
  })

  test('never leaks the full number', () => {
    expect(maskStudentNo('202101000001')).not.toContain('202101000001')
  })

  test('masks short numbers fully', () => {
    expect(maskStudentNo('123')).toBe('1*3')
  })
})

describe('AdminMeResponseSchema', () => {
  test('parses an admin me response with capabilities', () => {
    const body = {
      admin: {
        id: '01930000-0000-7000-8000-0000000000a1',
        nickname: '阿岚',
        avatarUrl: null,
        campus: '肇庆',
        authStatus: 'VERIFIED',
        verifiedAt: '2026-09-12T03:40:10.000Z',
        role: 'ADMIN',
      },
      capabilities: ['USERS_READ', 'LISTINGS_READ', 'OVERVIEW_READ', 'AUDIT_LOGS_READ'],
    }
    const parsed = AdminMeResponseSchema.parse(body)
    expect(parsed.admin.role).toBe('ADMIN')
    expect(parsed.capabilities).toHaveLength(4)
  })

  test('does not accept a USER in the admin me shape', () => {
    // /admin/me 只该给 ADMIN；结合服务端 requireAdmin，USER 到达不了这里。
    const parsed = AdminMeResponseSchema.safeParse({
      admin: {
        id: '01930000-0000-7000-8000-0000000000a1',
        nickname: '阿岚',
        avatarUrl: null,
        campus: null,
        authStatus: 'UNVERIFIED',
        verifiedAt: null,
        role: 'USER',
      },
      capabilities: [],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('AdminUserSummaryPageSchema', () => {
  test('parses a page with masked student no and nextCursor null', () => {
    const body = {
      items: [
        {
          id: '01930000-0000-7000-8000-0000000000a1',
          studentNoMasked: '2021****0001',
          nickname: '阿岚',
          campus: '肇庆',
          authStatus: 'VERIFIED',
          role: 'ADMIN',
          createdAt: '2026-09-12T03:40:10.000Z',
          listingCount: 3,
          lastActivityAt: '2026-09-12T03:40:10.000Z',
        },
      ],
      nextCursor: null,
    }
    const parsed = AdminUserSummaryPageSchema.parse(body)
    expect(parsed.items[0]?.studentNoMasked).toBe('2021****0001')
    expect(parsed.nextCursor).toBeNull()
  })
})

describe('AdminOverviewSchema', () => {
  test('parses the fixed-metric overview', () => {
    const body = {
      totalUsers: 120,
      newUsersLast24h: 3,
      activeListings: 80,
      completedTransactions: 40,
    }
    expect(AdminOverviewSchema.parse(body).activeListings).toBe(80)
  })

  test('rejects negative metrics', () => {
    const body = { totalUsers: -1, newUsersLast24h: 0, activeListings: 0, completedTransactions: 0 }
    expect(AdminOverviewSchema.safeParse(body).success).toBe(false)
  })
})

describe('AdminAuditLogEntrySchema', () => {
  test('parses an audit entry with actor, before/after snapshots and request id', () => {
    const body = {
      id: '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d',
      actor: { id: '01930000-0000-7000-8000-0000000000a1', nickname: '阿岚' },
      action: 'ADMIN_PROMOTED',
      targetType: 'USER',
      targetId: '01930000-0000-7000-8000-0000000000a1',
      before: { role: 'USER' },
      after: { role: 'ADMIN' },
      reason: '初始化管理后台',
      requestId: 'req-123',
      createdAt: '2026-09-12T03:40:10.000Z',
    }
    const parsed = AdminAuditLogEntrySchema.parse(body)
    expect(parsed.actor?.nickname).toBe('阿岚')
    expect(parsed.after).toEqual({ role: 'ADMIN' })
  })

  test('parses an audit entry with null actor (system-initiated)', () => {
    const body = {
      id: '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d',
      actor: null,
      action: 'ADMIN_PROMOTED',
      targetType: 'USER',
      targetId: '01930000-0000-7000-8000-0000000000a1',
      before: null,
      after: { role: 'ADMIN' },
      reason: '初始化',
      requestId: null,
      createdAt: '2026-09-12T03:40:10.000Z',
    }
    expect(AdminAuditLogEntrySchema.parse(body).actor).toBeNull()
  })

  test('rejects an unknown audit action', () => {
    const body = {
      id: '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d',
      actor: null,
      action: 'DROP_ALL',
      targetType: 'USER',
      targetId: '01930000-0000-7000-8000-0000000000a1',
      before: null,
      after: null,
      reason: null,
      requestId: null,
      createdAt: '2026-09-12T03:40:10.000Z',
    }
    expect(AdminAuditLogEntrySchema.safeParse(body).success).toBe(false)
  })
})

describe('AdminListingDetailSchema', () => {
  test('parses a listing detail with images and recent audit logs', () => {
    const body = {
      id: '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d',
      title: '罗技 K380 机械键盘',
      description: '自用一年。',
      priceCents: 16000,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: 'ACTIVE',
      urgent: false,
      negotiable: true,
      free: false,
      createdAt: '2026-09-12T03:40:10.000Z',
      updatedAt: '2026-09-12T03:40:10.000Z',
      images: [{ url: 'http://localhost:9000/fish/listings/a/0.jpg', sortOrder: 0 }],
      seller: { id: '01930000-0000-7000-8000-0000000000a1', nickname: '阿岚', campus: '肇庆' },
      recentAuditLogs: [],
    }
    const parsed = AdminListingDetailSchema.parse(body)
    expect(parsed.images).toHaveLength(1)
    expect(parsed.recentAuditLogs).toEqual([])
  })

  test('requires updatedAt, since listings.updated_at is NOT NULL', () => {
    const body = {
      id: '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d',
      title: '罗技 K380 机械键盘',
      description: '自用一年。',
      priceCents: 16000,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: 'ACTIVE',
      urgent: false,
      negotiable: true,
      free: false,
      createdAt: '2026-09-12T03:40:10.000Z',
      updatedAt: null,
      images: [],
      seller: { id: '01930000-0000-7000-8000-0000000000a1', nickname: '阿岚', campus: '肇庆' },
      recentAuditLogs: [],
    }
    expect(AdminListingDetailSchema.safeParse(body).success).toBe(false)
  })
})
