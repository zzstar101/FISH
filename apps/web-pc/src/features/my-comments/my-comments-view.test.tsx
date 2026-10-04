import { describe, expect, mock, test } from 'bun:test'
import type { MyCommentItem } from '@fish/contracts/comments/schema'
import type { ListingCard } from '@fish/contracts/listings/schema'
import type { TransactionReviewItem } from '@fish/contracts/transaction-reviews/schema'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * 仓库没有 jsdom，组件只做静态渲染；真 `Link` 在没有 router context 时会炸
 * （`router.isServer`），换成最简 `<a>` stub，把焦点留在视图分支上。
 */
mock.module('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
    createElement('a', { href: to, ...rest }, children),
}))

const { MY_COMMENTS_SEGMENTS, MyCommentsPageView } = await import('./my-comments-view')
type MyCommentsViewProps = import('./my-comments-view').MyCommentsViewProps

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

const listingId = 'lst_01jc000000e00800000000000k'
const transactionId = 'txn_01jc000000e00800000000000k'

function listingFixture(status: ListingCard['status']): ListingCard {
  return {
    id: listingId,
    title: '高等数学上册',
    priceCents: 2000,
    category: 'BOOKS',
    condition: 'GOOD',
    status,
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    moderationStatus: null,
  }
}

function commentItemFixture(parentId: MyCommentItem['comment']['parentId'] = null): MyCommentItem {
  return {
    comment: {
      id: 'cmt_01jc000000e00800000000000k',
      listingId,
      parentId,
      content: '还在吗？想收',
      createdAt: '2026-03-01T00:00:00.000Z',
    },
    listing: listingFixture('SOLD'),
  }
}

function reviewItemFixture(
  rating: TransactionReviewItem['review']['rating'],
): TransactionReviewItem {
  return {
    review: {
      id: 'rvw_01jc000000e00800000000004t',
      transactionId,
      rating,
      body: '卖家很爽快',
      images: [],
      createdAt: '2026-03-02T00:00:00.000Z',
    },
    transaction: {
      id: transactionId,
      conversationId: 'cnv_01jc000000e00800000000000k',
      listingId,
      buyerId: 'usr_01jc000000e00800000000000b',
      sellerId: 'usr_01jc000000e00800000000000a',
      role: 'buyer',
      listing: {
        id: listingId,
        title: '高等数学上册',
        priceCents: 2000,
        status: 'SOLD',
        coverUrl: null,
      },
      counterpart: { id: 'usr_01jc000000e00800000000000a', nickname: '小林', avatarUrl: null },
      amountCents: 1800,
      status: 'COMPLETED',
      buyerConfirmedAt: '2026-02-01T00:00:00.000Z',
      sellerConfirmedAt: '2026-02-01T00:00:00.000Z',
      completedAt: '2026-02-01T00:00:00.000Z',
      cancelledAt: null,
      createdAt: '2026-01-10T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    },
  }
}

function renderView(props: Partial<MyCommentsViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(MyCommentsPageView, {
      activeKind: 'comment',
      counts: { comment: 3, review: 1 },
      loading: false,
      error: false,
      items: [],
      hasNextPage: false,
      loadingMore: false,
      nextPageError: false,
      onKindChange: () => {},
      onRetry: () => {},
      onRetryNextPage: () => {},
      onLoadMore: () => {},
      ...props,
    }),
  )
}

describe('MyCommentsPageView', () => {
  test('加载中与整页失败各占一个分支', () => {
    expect(textOf(renderView({ loading: true }))).toContain('正在加载我的评论…')
    expect(textOf(renderView({ error: true }))).toContain('我的评论加载失败')
  })

  test('分段胶囊展示两段与各自计数，计数读不到显示未知而非 0', () => {
    const html = renderView()
    expect(textOf(html)).toContain('商品留言')
    expect(textOf(html)).toContain('交易评价')
    expect(html).toContain('>3</span>')
    expect(html).toContain('>1</span>')
    const unknownHtml = renderView({ counts: { comment: null, review: null } })
    expect(unknownHtml).toContain('>—</span>')
    expect(textOf(unknownHtml)).not.toContain('0')
  })

  test('当前分段由 aria-pressed 标识，两段互斥', () => {
    expect(renderView({ activeKind: 'comment' })).toContain('aria-pressed="true"')
    const reviewActive = renderView({ activeKind: 'review' })
    expect(reviewActive).toContain('aria-pressed="true"')
    expect(reviewActive.match(/aria-pressed="true"/g)).toHaveLength(1)
  })

  test('留言行渲染内容、回复标记与商品标题', () => {
    const html = renderView({
      items: [commentItemFixture(), commentItemFixture('cmt_01jc000000e00800000000004t')],
    })
    const text = textOf(html)
    expect(text).toContain('还在吗？想收')
    expect(text).toContain('商品：高等数学上册')
    expect(html.match(/回复<\/span>/g)).toHaveLength(1)
  })

  test('评价行渲染评分档、评语与交易对方，未写字不冒充评语', () => {
    const positive = renderView({ activeKind: 'review', items: [reviewItemFixture('POSITIVE')] })
    expect(textOf(positive)).toContain('好评')
    expect(textOf(positive)).toContain('卖家很爽快')
    expect(textOf(positive)).toContain('与 小林 的交易')
    const negativeNoBody = renderView({
      activeKind: 'review',
      items: [
        {
          ...reviewItemFixture('NEGATIVE'),
          review: { ...reviewItemFixture('NEGATIVE').review, body: null },
        },
      ],
    })
    expect(textOf(negativeNoBody)).toContain('差评')
    expect(textOf(negativeNoBody)).not.toContain('卖家很爽快')
  })

  test('空态按分段区分：留言空态指向去逛逛，评价空态指向去看订单', () => {
    const commentEmpty = renderView({ activeKind: 'comment', items: [] })
    expect(textOf(commentEmpty)).toContain('还没有留言')
    expect(commentEmpty).toContain('去逛逛')
    const reviewEmpty = renderView({ activeKind: 'review', items: [] })
    expect(textOf(reviewEmpty)).toContain('还没有评价')
    expect(reviewEmpty).toContain('去看订单')
  })

  test('还有下一页时给加载更多；翻页失败保留列表并行内重试', () => {
    expect(renderView({ hasNextPage: true })).toContain('加载更多')
    expect(
      renderView({ hasNextPage: true, loadingMore: true, items: [commentItemFixture()] }),
    ).toContain('正在加载…')
    const nextPageError = renderView({
      hasNextPage: true,
      nextPageError: true,
      items: [commentItemFixture()],
    })
    expect(textOf(nextPageError)).toContain('更多评论加载失败')
    expect(textOf(nextPageError)).toContain('还在吗？想收')
    expect(textOf(nextPageError)).not.toContain('加载更多')
    expect(textOf(nextPageError)).not.toContain('我的评论加载失败')
  })
})

test('分段定义只暴露契约冻结的 kind 口径', () => {
  expect(MY_COMMENTS_SEGMENTS.map((segment) => segment.kind)).toEqual(['comment', 'review'])
})
