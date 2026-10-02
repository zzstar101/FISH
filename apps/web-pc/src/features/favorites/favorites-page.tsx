import { useState } from 'react'
import { useAuth } from '../auth/auth-provider'
import type { CancelFailure, FavoriteRow } from './favorites-view'
import { FavoritesPageView } from './favorites-view'
import { useFavoritesTotal, useMyFavorites, useUnfavoriteMutation } from './queries'

export function FavoritesPage() {
  const { me } = useAuth()
  if (!me) return null
  return <FavoritesContent key={me.id} ownerId={me.id} />
}

function FavoritesContent({ ownerId }: { ownerId: string }) {
  const [cancelFailure, setCancelFailure] = useState<CancelFailure>(null)
  const favorites = useMyFavorites(ownerId)
  const totalQuery = useFavoritesTotal(ownerId)
  const unfavorite = useUnfavoriteMutation()

  const items: FavoriteRow[] = favorites.data?.pages.flatMap((page) => page.items) ?? []

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
        total={totalQuery.isError ? null : (totalQuery.data ?? null)}
      />
    </div>
  )
}
