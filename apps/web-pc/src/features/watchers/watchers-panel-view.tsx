import type { ChatWatchersResponse } from '@fish/contracts/chat/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { ShieldCheck } from 'lucide-react'
import { formatRelativeTimeAt } from '../../lib/format'
import type { WatchersLoadOutcome } from './api'

/**
 * 名单行 = 契约 `chatWatchersResponseSchema.items[]`，一字不多。
 *
 * 直接取契约的元素类型而不是手抄一份字段表：契约刚加 `conversationId`（小程序用它做
 * 「点名字打开该买家会话」的跳转），手抄的那份不会跟着变，两处一旦漂移，
 * 页面上就会缺字段而没有任何编译错误。
 */
export type WatcherRow = ChatWatchersResponse['items'][number]

/**
 * 名单状态。`listing-missing` / `not-owner` 是**业务边界**（404 / 403），
 * 渲染成空态而不是系统错误；`error` 才是网络 / 500 这类可重试失败。
 */
export type WatchersPanelState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'listing-missing'
  | 'not-owner'
  | 'error'

export type WatchersPanelViewProps = {
  state: WatchersPanelState
  /** 名单全量人数（服务端 COUNT，非当前页行数）；未取到为 null。 */
  total: number | null
  items: WatcherRow[]
  errorMessage: string | null
  hasNextPage: boolean
  fetchingNextPage: boolean
  /** 「加载更多」这一页失败了：数据仍在，失败只属于追加的那页。 */
  nextPageFailed: boolean
  onLoadMore: () => void
  onRetry: () => void
}

/**
 * 「谁想要」名单**面板**的展示层（#381）。props 驱动、不 import router 也不读 query，
 * 也不含 `<Dialog>` —— radix 的 Portal 在 `renderToStaticMarkup` 下什么都渲染不出来，
 * 所以弹窗外壳由 `watchers-dialog.tsx` 负责，这里只做内容，才能被静态渲染测试
 * （用例见 `./watchers-panel-view.test.tsx`）。
 *
 * 只渲染契约给的字段：`user`（id / nickname / avatarUrl / authStatus）+ `startedAt`。
 * 不编造评分、成交量、预算（契约里没有，#381「明确不做」）。
 */
export function WatchersPanelView({
  state,
  total,
  items,
  errorMessage,
  hasNextPage,
  fetchingNextPage,
  nextPageFailed,
  onLoadMore,
  onRetry,
}: WatchersPanelViewProps) {
  return (
    <div className="space-y-4" data-slot="watchers-panel">
      {state === 'loading' ? <LoadingState label="正在读取想要的人…" /> : null}

      {state === 'listing-missing' ? (
        <EmptyState
          description="它可能已被删除，或链接已过期。"
          emoji="🔍"
          title="商品不存在或已删除"
        />
      ) : null}

      {state === 'not-owner' ? (
        <EmptyState
          description="名单只有商品卖家本人可以查看。"
          emoji="🔒"
          title="只能查看自己商品的想要的人"
        />
      ) : null}

      {state === 'error' ? (
        <ErrorState message={errorMessage ?? '名单加载失败'} onRetry={onRetry} />
      ) : null}

      {state === 'empty' ? (
        <EmptyState
          description="买家在商品详情点「我想要」发起会话后，会出现在这里。"
          emoji="🫧"
          title='还没有人点过"我想要"'
        />
      ) : null}

      {state === 'ready' ? (
        <>
          <ul className="divide-y divide-line" data-slot="watcher-list">
            {items.map((item) => (
              <li className="flex items-center gap-3 py-3 first:pt-0" key={item.user.id}>
                <UserAvatar
                  avatarUrl={item.user.avatarUrl}
                  emoji={item.user.nickname.slice(0, 1)}
                  size="default"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">{item.user.nickname}</p>
                  <p className="mt-0.5 text-ink-3 text-xs">
                    {formatRelativeTimeAt(item.startedAt)}想要
                  </p>
                </div>
                {item.user.authStatus === 'VERIFIED' ? (
                  <Badge className="gap-1" variant="success">
                    <ShieldCheck className="size-3.5" />
                    已认证
                  </Badge>
                ) : (
                  <Badge variant="secondary">未认证</Badge>
                )}
              </li>
            ))}
          </ul>

          {nextPageFailed ? (
            <ErrorState message="加载更多失败" onRetry={onLoadMore} />
          ) : hasNextPage ? (
            <div className="flex justify-center">
              <Button
                disabled={fetchingNextPage}
                onClick={onLoadMore}
                type="button"
                variant="outline"
              >
                {fetchingNextPage ? '正在加载…' : '加载更多'}
              </Button>
            </div>
          ) : (
            <p className="text-center text-ink-3 text-xs">已显示全部 {total ?? items.length} 人</p>
          )}
        </>
      ) : null}
    </div>
  )
}

/**
 * 弹窗副标题的人数口径：`null` = 还没取到（首屏 loading 期间给中性提示），
 * `0` = 真的还没有人想要（空态会接管正文，这里仍给出「共 0 人想要」保持数字一致）。
 * 抽成函数是因为它渲染在弹窗外壳（DialogDescription）里，静态渲染测不到，只能钉住文案本身。
 */
export function watchersTotalLabel(total: number | null): string {
  return total === null ? '「我想要」过的买家会出现在这里。' : `共 ${total} 人想要`
}

/**
 * 容器的状态推导，纯函数（web-pc 无 jsdom，容器里的 hook 逻辑测不了）。
 *
 * 关键口径：**失败分两种时机**——
 * - 首屏失败（还没拿到过数据）：按错误映射走；
 * - **缓存复用窗口内 refetch 失败**（手上还有上一份名单）：404/403 仍然必须降级成业务空态
 *   ——商品可能在别的标签页刚被删掉，此时继续展示陈旧名单等于给卖家假信息；
 *   其余失败（网络 / 500）则保留已加载的名单（数据只是旧一点，下一轮打开会再试）。
 */
export function watchersPanelState(input: {
  pending: boolean
  failure: WatchersLoadOutcome | null
  itemCount: number
}): WatchersPanelState {
  if (input.pending) return 'loading'
  if (input.failure !== null) {
    if (input.failure.kind === 'listing-missing') return 'listing-missing'
    if (input.failure.kind === 'not-owner') return 'not-owner'
    if (input.itemCount === 0) return 'error'
  }
  return input.itemCount === 0 ? 'empty' : 'ready'
}
