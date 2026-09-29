import type { ListingImage } from '@fish/contracts/listings/schema'
import type { ListingId } from '@fish/contracts/system/public-id'
import { useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { trackListingEvent } from '../recommendation/track'

export function ListingGallery({
  images,
  listingId,
  title,
}: {
  images: ListingImage[]
  listingId: ListingId
  title: string
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(() => new Set())
  const orderedImages = [...images].sort((a, b) => a.sortOrder - b.sortOrder)
  const activeIndex =
    orderedImages.length > 0 ? Math.min(selectedIndex, orderedImages.length - 1) : 0
  const active = orderedImages[activeIndex]

  function markImageFailed(url: string) {
    setFailedUrls((current) => {
      const next = new Set(current)
      next.add(url)
      return next
    })
  }

  function selectImage(index: number) {
    // 点已经展示的那张不算「查看」：否则连点同一个缩略图会刷出一串 IMAGE_VIEW。
    if (index === activeIndex) return
    setSelectedIndex(index)
    // 只有用户主动切图才上报：首屏自动展示第一张不算「查看」。
    trackListingEvent({ listingId, eventType: 'IMAGE_VIEW', metadata: { imageIndex: index } })
  }
  const showFallback = active === undefined || failedUrls.has(active.url)

  return (
    <div>
      {showFallback ? (
        <ListingThumb
          alt={title}
          className="aspect-[4/3] w-full rounded-2xl"
          coverUrl={null}
          emojiClassName="text-8xl"
          listingId={listingId}
        />
      ) : (
        <img
          alt={`${title} 图片 ${activeIndex + 1}`}
          className="aspect-[4/3] w-full rounded-2xl border border-line bg-surface-2 object-contain"
          onError={() => markImageFailed(active.url)}
          src={active.url}
        />
      )}
      {orderedImages.length > 1 ? (
        <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
          {orderedImages.map((image, index) => (
            <button
              aria-label={`查看第 ${index + 1} 张图片`}
              aria-pressed={activeIndex === index}
              className={`overflow-hidden rounded-xl border-2 transition-colors ${
                activeIndex === index ? 'border-brand' : 'border-transparent hover:border-brand/40'
              }`}
              key={image.url}
              onClick={() => selectImage(index)}
              type="button"
            >
              {failedUrls.has(image.url) ? (
                <ListingThumb
                  alt={title}
                  className="h-20 w-24 rounded-none"
                  coverUrl={null}
                  emojiClassName="text-2xl"
                  listingId={`${listingId}-${image.sortOrder}`}
                />
              ) : (
                <img
                  alt=""
                  className="h-20 w-24 object-cover"
                  loading="lazy"
                  onError={() => markImageFailed(image.url)}
                  src={image.url}
                />
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
