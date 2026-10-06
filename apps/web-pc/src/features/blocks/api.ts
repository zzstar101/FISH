import { BLOCK_ROUTES } from '@fish/contracts/blocks/routes'
import {
  type BlockState,
  BlockStateSchema,
  type MyBlocksResponse,
  MyBlocksResponseSchema,
} from '@fish/contracts/blocks/schema'
import { UserIdSchema } from '@fish/contracts/system/public-id'
import { ApiError, apiRequest, isUnauthenticatedError } from '../../lib/api-client'

/**
 * 拉黑域端上客户端（#466）：拼路径 + 发请求 + 契约收口 + 失败归类。
 *
 * 与 follows/api.ts 同构。**守卫在服务端**：拉黑后发送/建会话的 403
 * `CONVERSATION_UNAVAILABLE` 由 chat 域的 `describeSendFailure` 兜文案，本文件不管。
 */

/** 黑名单每页条数：契约默认 20、上限 50，端上取默认。 */
export const BLOCKS_PAGE_LIMIT = 20

export function myBlocksPath(input: { limit: number; cursor?: string }): string {
  const params = new URLSearchParams({ limit: String(input.limit) })
  if (input.cursor !== undefined) params.set('cursor', input.cursor)
  return `${BLOCK_ROUTES.myBlocks}?${params.toString()}`
}

/** 用户 id 是路由参数（用户可见输入），拼 URL 前先过契约校验，不合法直接当不存在。 */
export function blockRelationPath(userId: string): string | null {
  if (!UserIdSchema.safeParse(userId).success) return null
  return BLOCK_ROUTES.blockRelation(userId)
}

export async function fetchMyBlocks(input: {
  limit: number
  cursor?: string
}): Promise<MyBlocksResponse> {
  return MyBlocksResponseSchema.parse(await apiRequest(myBlocksPath(input)))
}

export type BlockStateOutcome =
  | { kind: 'loaded'; blocked: boolean }
  | { kind: 'notFound' }
  | { kind: 'failed'; message: string }

function blockErrorText(error: unknown): string {
  if (error instanceof ApiError && error.message.length > 0) return error.message
  return '网络异常，请稍后重试'
}

/**
 * 读与某人的拉黑状态。404 USER_NOT_FOUND 单独成 `notFound`（降级「无法拉黑」），
 * 与网络/服务端失败分开——后者保留重试，两种都不能让按钮假装成未拉黑可点。
 * 401 UNAUTHENTICATED 原样抛出，交给全站 401 收口。
 */
export async function fetchBlockState(userId: string): Promise<BlockStateOutcome> {
  const path = blockRelationPath(userId)
  if (path === null) return { kind: 'notFound' }
  try {
    const state = BlockStateSchema.parse(await apiRequest(path))
    return { kind: 'loaded', blocked: state.blocked }
  } catch (error) {
    if (isUnauthenticatedError(error)) throw error
    if (error instanceof ApiError && error.status === 404 && error.code === 'USER_NOT_FOUND') {
      return { kind: 'notFound' }
    }
    return { kind: 'failed', message: blockErrorText(error) }
  }
}

export type BlockWriteResult =
  | { kind: 'written'; blocked: boolean }
  | { kind: 'failed'; message: string }

/**
 * 拉黑 / 解除：失败不改本地状态（以服务端结论为准）。
 * `CANNOT_BLOCK_SELF`（422）落到 `failed`（端上不渲染自己的拉黑钮，这条是兜底）。
 * 401 UNAUTHENTICATED 原样抛出，交给全站 401 收口。
 */
async function writeBlock(userId: string, method: 'POST' | 'DELETE'): Promise<BlockWriteResult> {
  const path = blockRelationPath(userId)
  if (path === null) return { kind: 'failed', message: '用户不存在或不可见' }
  try {
    const state: BlockState = BlockStateSchema.parse(await apiRequest(path, { method }))
    return { kind: 'written', blocked: state.blocked }
  } catch (error) {
    if (isUnauthenticatedError(error)) throw error
    return { kind: 'failed', message: blockErrorText(error) }
  }
}

export function requestBlock(userId: string): Promise<BlockWriteResult> {
  return writeBlock(userId, 'POST')
}

export function requestUnblock(userId: string): Promise<BlockWriteResult> {
  return writeBlock(userId, 'DELETE')
}
