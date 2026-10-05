import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeBlockCursor, encodeBlockCursor } from './cursor'
import { BlockServiceError, createBlockService } from './service'
import type { BlockCursor, BlockedRow, BlockStore } from './store'

const VIEWER = '01930000-0000-7000-8000-00000000000a'
const TARGET = '01930000-0000-7000-8000-00000000000b'
const THIRD = '01930000-0000-7000-8000-00000000000c'

function row(id: string, overrides: Partial<BlockedRow> = {}): BlockedRow {
  return {
    id,
    nickname: '林一',
    avatarUrl: null,
    authStatus: 'VERIFIED',
    blockedAtCursor: '2026-10-05T02:00:00.000000Z',
    ...overrides,
  }
}

class MemoryStore implements BlockStore {
  users = new Set<string>([VIEWER, TARGET, THIRD])
  /** 已建立的有向边（`blocker → blocked`）。 */
  edges = new Set<string>()
  rows: BlockedRow[] = []
  private key(a: string, b: string) {
    return `${a}>${b}`
  }

  async userExists(userId: string) {
    return this.users.has(userId)
  }
  async listBlocks(blockerId: string, limit: number, cursor: BlockCursor | null) {
    // store 契约：多取一行（limit + 1），由 service 判断还有没有下一页。
    void blockerId
    void cursor
    return this.rows.slice(0, limit + 1)
  }
  async isBlocked(blockerId: string, blockedId: string) {
    return this.edges.has(this.key(blockerId, blockedId))
  }
  async existsBlockBetween(a: string, b: string) {
    return this.edges.has(this.key(a, b)) || this.edges.has(this.key(b, a))
  }
  async block(blockerId: string, blockedId: string) {
    this.edges.add(this.key(blockerId, blockedId))
  }
  async unblock(blockerId: string, blockedId: string) {
    this.edges.delete(this.key(blockerId, blockedId))
  }
}

describe('block service: 写操作', () => {
  test('block → blocked true；重复拉黑幂等', async () => {
    const service = createBlockService({ store: new MemoryStore() })
    expect(await service.block(VIEWER, TARGET)).toEqual({ blocked: true })
    expect(await service.block(VIEWER, TARGET)).toEqual({ blocked: true })
  })

  test('拉黑自己 → 422 CANNOT_BLOCK_SELF（写接口与解除同一判据）', async () => {
    const service = createBlockService({ store: new MemoryStore() })
    expect(
      (await service.block(VIEWER, VIEWER).catch((e) => e)) as BlockServiceError,
    ).toBeInstanceOf(BlockServiceError)
    await expect(service.block(VIEWER, VIEWER)).rejects.toMatchObject({
      status: 422,
      code: 'CANNOT_BLOCK_SELF',
    })
    // 解除自己也是同一判据（与自己的关系不可表达）。
    await expect(service.unblock(VIEWER, VIEWER)).rejects.toMatchObject({
      status: 422,
      code: 'CANNOT_BLOCK_SELF',
    })
  })

  test('目标不存在 → 404 USER_NOT_FOUND（非法 uuid 与不存在同码）', async () => {
    const service = createBlockService({ store: new MemoryStore() })
    await expect(
      service.block(VIEWER, '01930000-0000-7000-8000-0000000000ff'),
    ).rejects.toMatchObject({ status: 404, code: 'USER_NOT_FOUND' })
    await expect(
      service.getState(VIEWER, '01930000-0000-7000-8000-0000000000ff'),
    ).rejects.toMatchObject({ status: 404, code: 'USER_NOT_FOUND' })
  })

  test('unblock → blocked false；对未拉黑的人解除也是幂等成功', async () => {
    const store = new MemoryStore()
    const service = createBlockService({ store })
    await service.block(VIEWER, TARGET)
    expect(await service.unblock(VIEWER, TARGET)).toEqual({ blocked: false })
    expect(await service.unblock(VIEWER, TARGET)).toEqual({ blocked: false })
    expect(store.edges.has(`${VIEWER}>${TARGET}`)).toBe(false)
  })

  test('getState 反映单向关系（我拉黑了 TA ≠ TA 拉黑了我）', async () => {
    const store = new MemoryStore()
    const service = createBlockService({ store })
    await service.block(VIEWER, TARGET)
    expect(await service.getState(VIEWER, TARGET)).toEqual({ blocked: true })
    expect(await service.getState(TARGET, VIEWER)).toEqual({ blocked: false })
  })
})

describe('block service: listMyBlocks', () => {
  test('丢弃预取行并从最后一条已返回行派生游标', async () => {
    const store = new MemoryStore()
    store.rows = [row(TARGET), row(THIRD), row('01930000-0000-7000-8000-00000000000d')]
    const service = createBlockService({ store })

    const page = await service.listMyBlocks(VIEWER, { limit: 2 })

    expect(page.items).toHaveLength(2)
    expect(page.items.map((item) => item.id)).toEqual([
      encodePublicId(PUBLIC_ID_PREFIX.user, TARGET),
      encodePublicId(PUBLIC_ID_PREFIX.user, THIRD),
    ])
    expect(page.nextCursor).not.toBeNull()
    // 游标真实往返：page.nextCursor 解码回「最后一条已返回行」的 (createdAt, 内部 uuid)。
    expect(decodeBlockCursor(page.nextCursor ?? '')).toEqual({
      createdAt: '2026-10-05T02:00:00.000000Z',
      id: THIRD,
    })
  })

  test('decodeBlockCursor 对非法输入一律 null（裸 uuid / 错误前缀 / 非法日期 / 坏形状）', () => {
    const good = encodeBlockCursor({ createdAt: '2026-10-05T02:00:00.000000Z', id: TARGET })
    expect(decodeBlockCursor(good)).not.toBeNull()
    // 裸 UUID（未编码成 usr_ 公开 id）
    expect(
      decodeBlockCursor(
        Buffer.from(
          JSON.stringify({ createdAt: '2026-10-05T02:00:00.000000Z', id: TARGET }),
        ).toString('base64url'),
      ),
    ).toBeNull()
    // 错误前缀（商品 id）
    expect(
      decodeBlockCursor(
        Buffer.from(
          JSON.stringify({
            createdAt: '2026-10-05T02:00:00.000000Z',
            id: 'lst_01jc000000e00800000000000c',
          }),
        ).toString('base64url'),
      ),
    ).toBeNull()
    // 形状合法但日期非法（会被 ::timestamptz 拒绝 → 必须先挡）
    expect(
      decodeBlockCursor(
        Buffer.from(
          JSON.stringify({
            createdAt: '2026-13-40T99:00:00.000000Z',
            id: encodePublicId(PUBLIC_ID_PREFIX.user, TARGET),
          }),
        ).toString('base64url'),
      ),
    ).toBeNull()
    expect(decodeBlockCursor('not-base64-json')).toBeNull()
  })

  test('空列表 nextCursor 为 null', async () => {
    const service = createBlockService({ store: new MemoryStore() })
    const page = await service.listMyBlocks(VIEWER, { limit: 20 })
    expect(page.items).toHaveLength(0)
    expect(page.nextCursor).toBeNull()
  })

  test('非法游标 → 422 VALIDATION_FAILED', async () => {
    const service = createBlockService({ store: new MemoryStore() })
    await expect(
      service.listMyBlocks(VIEWER, { limit: 20, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' })
  })
})
