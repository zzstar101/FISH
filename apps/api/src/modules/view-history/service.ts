import type { ApiErrorDetail, SystemErrorCode } from '@fish/contracts/system/error'
import type {
  ClearViewHistoryResponse,
  MyViewHistoryQuery,
  MyViewHistoryResponse,
  ViewHistoryItem,
} from '@fish/contracts/view-history/schema'
import { VIEW_HISTORY_RETENTION_MS } from '@fish/contracts/view-history/schema'
import { toListingCard } from '../listings/card'
import type { MediaStorage } from '../uploads/storage'
import { decodeViewHistoryCursor, encodeViewHistoryCursor } from './cursor'
import type { ViewHistoryRow, ViewHistoryStore } from './store'

/**
 * 浏览记录的业务层（#415 M1）。
 *
 * 本域没有领域错误码：读/清都只作用于"我自己的行"，既没有 404（没有"别人的记录"这个概念），
 * 也没有写冲突。唯一的失败输入是非法游标 → 422 `VALIDATION_FAILED`（取 system 的成员，
 * 不重写字面量）。
 */
export class ViewHistoryServiceError extends Error {
  constructor(
    readonly status: 422,
    readonly code: Extract<SystemErrorCode, 'VALIDATION_FAILED'>,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'ViewHistoryServiceError'
  }
}

/** 非法游标 → 422（与 listings feed / 收藏同一结论），不做"宽容解析"。 */
const invalidCursor = () =>
  new ViewHistoryServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
    { field: 'cursor', message: 'cursor 无效' },
  ])

/**
 * 逐字段组装行（**不是** `{...row}`）：谁想多带一个字段都得改这行字面量。
 * 卡片走共享的 `toListingCard`，且**不传**审核态三参数 —— 浏览者是买家视角，
 * 公开投影的 `moderationStatus` / `governanceDelisted` / `moderationReason` 恒为 `null`。
 */
function toViewHistoryItem(
  row: ViewHistoryRow,
  storage: Pick<MediaStorage, 'publicUrl'>,
): ViewHistoryItem | null {
  const listing = toListingCard(row, row.coverObjectKey, storage)
  if (listing === null) return null
  return { listing, viewedAt: row.viewedAt }
}

export interface ViewHistoryService {
  listMine(userId: string, query: MyViewHistoryQuery): Promise<MyViewHistoryResponse>
  clearMine(userId: string): Promise<ClearViewHistoryResponse>
}

export function createViewHistoryService({
  store,
  storage,
  now = () => new Date(),
}: {
  store: ViewHistoryStore
  storage: Pick<MediaStorage, 'publicUrl'>
  /** 注入时钟：30 天窗口的边界测试需要确定的"现在"，运行期默认取系统时间。 */
  now?: () => Date
}): ViewHistoryService {
  return {
    async listMine(userId, query) {
      const cursor = query.cursor === undefined ? null : decodeViewHistoryCursor(query.cursor)
      if (query.cursor !== undefined && cursor === null) throw invalidCursor()

      // 列表与 total 用同一个窗口起点：数字栏与列表不能各算各的。
      const since = new Date(now().getTime() - VIEW_HISTORY_RETENTION_MS)
      const [rows, total] = await Promise.all([
        store.listViewHistory(userId, query.limit, cursor, since),
        store.totalViewHistory(userId, since),
      ])

      const page = rows.slice(0, query.limit)
      const items: ViewHistoryItem[] = []
      for (const row of page) {
        const item = toViewHistoryItem(row, storage)
        if (item !== null) items.push(item)
      }

      const last = page.at(-1)
      return {
        items,
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeViewHistoryCursor({
                viewedAt: last.viewedAtCursor,
                listingId: last.id,
              })
            : null,
        total,
      }
    },

    async clearMine(userId) {
      // 幂等：没有记录也回 200 `{ deleted: 0 }`（端上重复点「清空」不是错误）。
      return { deleted: await store.clearViewHistory(userId) }
    },
  }
}
