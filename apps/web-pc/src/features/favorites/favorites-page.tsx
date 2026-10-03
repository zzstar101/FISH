import { useState } from 'react'
import { useAuth } from '../auth/auth-provider'
import type { CancelFailure, FavoriteRow } from './favorites-view'
import { FavoritesPageView } from './favorites-view'
import { useMyFavorites, useUnfavoriteMutation } from './queries'

export function FavoritesPage() {
  const { me } = useAuth()
  if (!me) return null
  return <FavoritesContent key={me.id} ownerId={me.id} />
}

function FavoritesContent({ ownerId }: { ownerId: string }) {
  const [cancelFailure, setCancelFailure] = useState<CancelFailure>(null)
  const favorites = useMyFavorites(ownerId)
  // total 直接取列表响应自带的全量计数（每页都带），不再单独发一次 GET。
  // 个人中心没有列表查询，那里的计数才走 useFavoritesTotal。
  const unfavorite = useUnfavoriteMutation()

  const items: FavoriteRow[] = favorites.data?.pages.flatMap((page) => page.items) ?? []
  const total = favorites.data?.pages[0]?.total ?? null

  function handleCancel(listingId: string) {
    setCancelFailure(null)
    unfavorite.mutate(listingId, {
      onSuccess: (result) => {
        if (result.kind === 'failed') {
          setCancelFailure({ listingId, message: result.message })
        }
      },
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">我的收藏</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          收藏的商品在售时随时回来看；已售出或下架的条目仍可取消收藏。
        </p>
      </div>
      <FavoritesPageView
        cancelFailure={cancelFailure}
        cancelingId={unfavorite.isPending ? (unfavorite.variables ?? null) : null}
        error={favorites.isError}
        hasNextPage={favorites.hasNextPage}
        items={items}
        loading={favorites.isPending}
        loadingMore={favorites.isFetchingNextPage}
        onCancel={handleCancel}
        onLoadMore={() => void favorites.fetchNextPage()}
        onRetry={() => void favorites.refetch()}
        total={total}
      />
    </div>
  )
}
