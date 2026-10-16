/**
 * 「我的评论」列表里评价配图的签名 URL 过期后，**不打扰列表**地换一批新地址
 * （#485 审查 P2）。
 *
 * 背景：评价图是 900 秒的 capability URL（`REVIEW_MEDIA_URL_TTL_SECONDS`），页面挂后台
 * 超过 15 分钟回来就全是裂图，只能按 `onError` 补读（契约不带 `expiresAt`，端上拼不出地址，
 * 新地址只有重读列表才拿得到）。
 *
 * 为什么不能复用页面的 `read()`（旧写法就是它）：`read()` 是「首屏读」——
 * `setItems(response.items)` 覆盖 + 重置 cursor + 置 loading/error。用户翻到第 3 页时
 * 一张缩略图裂掉就会把列表打回第 1 页（后面已加载的行整片消失、阅读位置丢失），
 * 补读请求失败还会把好端端的列表换成整页错误态；整屏缩略图一起裂是常态，那时每张图
 * 各发一次首屏读，还会互相顶掉（页面的 `loadEpoch` 代次丢弃迟到响应）。
 *
 * 所以补读走这条独立的路：
 * 1. **一批只跑一个补读周期**：闸门在 `@/features/transaction/image-reload`（`inFlightUrl`），
 *    同一批同时裂掉的图只并入**一个**周期（周期内按页串行读，见第 2 条的页数上限）；
 * 2. **按已加载页数回走**列表，只取「行 id → 新地址」（页数上限 `IMAGE_REFRESH_MAX_PAGES`，
 *    超出部分等下拉刷新）；
 * 3. **按 id 合并**进现有行 —— 行数、行序、cursor、loading/error 一个都不动；
 *    合并按 id 而不是下标：两次读之间列表可能新增行（对方刚评），按下标会对错行。
 *
 * 代次失守（换号 / 又一次重读 / 切段）时整批丢弃，与 `read()` 的 epoch 闸同一口径。
 *
 * 本模块不 import 任何 Taro 模块（只收类型），`bun test` 直接加载。
 */
import type { MyCommentItem, MyCommentsResponse } from '@fish/contracts/comments/schema'
import type { TransactionReviewItem } from '@fish/contracts/transaction-reviews/schema'
import {
  finishImageReload,
  type ImageReloadState,
  noteImageFailure,
} from '@/features/transaction/image-reload'
import type { MyComment } from './mine'

/**
 * 一次补读最多回走几页。用户翻得再多也只补到这一页为止 —— 补读是**兜底**，
 * 为几十页之外的裂图把整份列表重读一遍不值当。
 *
 * **代价写清楚**：超出这一段的行（第 11 页起）既不会在这次补读里换到新地址，
 * 也不会再次触发补读（它们就是触发这次的地址，已在 `attempted` 里），只能等下拉刷新。
 * 20 条 / 页时这一段是 200 行，正常用法够用；要改的话连同这条取舍一起改。
 */
export const IMAGE_REFRESH_MAX_PAGES = 10

/** 补读要回走的页数：至少 1 页（首屏），最多 `max` 页。 */
export function imageRefreshPages(
  loadedPages: number,
  max: number = IMAGE_REFRESH_MAX_PAGES,
): number {
  if (loadedPages < 1) return 1
  return Math.min(loadedPages, max)
}

/**
 * 把补读拿到的新地址按**行 id** 合并进现有列表。
 *
 * 地址与屏上完全一致的行走**原对象引用**（同一秒重签出同一地址、无图行都会命中）——
 * 换新对象只会让 Taro 多做一轮 diff。行序、行数与入参完全一致，调用方只 `setItems`
 * 这一个，cursor / loading / error 都不碰。
 */
export function mergeRefreshedImages(
  rows: readonly MyComment[],
  fresh: ReadonlyMap<string, string[]>,
): MyComment[] {
  return rows.map((row) => {
    const images = fresh.get(row.id)
    if (images === undefined || sameImages(row.images, images)) return row
    return { ...row, images }
  })
}

function sameImages(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((url, index) => url === right[index])
}

export type ImageRefreshArgs = {
  /** 补读闸门（组件存活期内同一个，见 `@/features/transaction/image-reload`） */
  state: ImageReloadState
  /** 刚裂掉的那张图的地址（判据：同一 URL 不重复补读） */
  url: string
  /**
   * 触发这次补读的**行 id**。批次只有在补读结果里**确实带回这一行**时才算成功：
   * 列表是 newest-first 的 keyset 分页，屏上加载 N 页后前面若新增了行，原第 N 页末尾的
   * 可见行会挪到第 N+1 页；只回放前 N 页会漏掉它，却把批次记成功、把它的 URL 留在
   * `attempted` 里 —— 这张图从此再也补不了（#485 审查第四轮 P2）。
   */
  rowId: string
  /** 当前列表已加载的页数（首屏 = 1，每次续页 +1） */
  loadedPages: number
  /** 取一页；`cursor` 为 `undefined` = 首屏，其余原样回传服务端 `nextCursor` */
  fetchPage: (cursor: string | undefined) => Promise<MyCommentsResponse>
  /** 契约行 → 页面行（只为拿 `id` 与 `images`，用页面同一把尺子） */
  mapItem: (item: MyCommentItem | TransactionReviewItem) => MyComment
  /** 代次判据：返回 `false`（换号 / 重读 / 切段）时中止并回 `null`，调用方不得落地 */
  isCurrent: () => boolean
  maxPages?: number
}

type Attempt =
  | { outcome: 'ok'; fresh: Map<string, string[]> }
  /** 回走完了（到底 / 到页数上限）但没见到触发行：别的行的新地址照样可用，但本批不算成功 */
  | { outcome: 'missed'; fresh: Map<string, string[]> }
  | { outcome: 'stale' }
  | { outcome: 'failed' }

async function attemptRefresh(args: ImageRefreshArgs): Promise<Attempt> {
  try {
    const max = args.maxPages ?? IMAGE_REFRESH_MAX_PAGES
    const pages = imageRefreshPages(args.loadedPages, max)
    const collected = new Map<string, string[]>()
    let cursor: string | undefined
    // 回走 `pages` 页；触发行还没见到就**继续走**，直到页数上限（分页成员位移时
    // 它可能落在已加载页数之外的下一页）。见到触发行且走满 `pages` 页就停。
    for (let page = 0; page < pages || (!collected.has(args.rowId) && page < max); page += 1) {
      const response = await args.fetchPage(cursor)
      if (!args.isCurrent()) return { outcome: 'stale' }
      for (const item of response.items) {
        const row = args.mapItem(item)
        collected.set(row.id, row.images)
      }
      if (response.nextCursor === null) break
      cursor = response.nextCursor
    }
    return { outcome: collected.has(args.rowId) ? 'ok' : 'missed', fresh: collected }
  } catch (caught) {
    // 补读失败**不升级**成列表错误态（列表本身还是好的，只是图暂时裂着）；
    // 留一行排障线索，与 `features/comments/index.tsx` 的失败日志同款。
    console.error('[my-comments] 评价配图补读失败', caught)
    return { outcome: 'failed' }
  }
}

/**
 * 一次完整的补读：闸门 → 按页回走 → 返回「行 id → 新地址」；不该补读 / 中途失守 /
 * 请求失败都回 `null`（调用方据此不做任何状态更新）。
 *
 * 闸门一定在拿到结局后释放，并如实带成功标志：失败 / 中止时 `finishImageReload`
 * 会把触发地址从 `attempted` 里撤掉 —— 否则「这一批补读失败」会被记成「这些图补过了」。
 *
 * **失败后自动重试一次**（审查第四轮 P2）：`<Image>` 的 `onError` 是一次性的，
 * 在飞期间并入的裂图与触发这一批的那张图都不会再发第二次事件，所以请求失败时由闸门
 * 给出触发地址、这里重走一遍（吃批次预算，一条失败链最多一次）。代次失守不重试
 * （重读 / 切段 / 换号已经换了一批行，新行自己会发 `onError`）；触发行没被覆盖也不重试
 * （确定性结果，重试只是白花请求）—— 这两种只撤销记账，且仍把已拿到的其余行地址交给调用方合并。
 */
export async function runImageRefresh(
  args: ImageRefreshArgs,
): Promise<Map<string, string[]> | null> {
  let url = args.url
  for (;;) {
    if (!noteImageFailure(args.state, url)) return null
    const attempt = await attemptRefresh(args)
    const retryUrl = finishImageReload(
      args.state,
      attempt.outcome === 'ok',
      attempt.outcome === 'failed',
    )
    if (attempt.outcome === 'ok' || attempt.outcome === 'missed') return attempt.fresh
    if (retryUrl === null) return null
    url = retryUrl
  }
}
