import { createFileRoute } from '@tanstack/react-router'
import { PublishPage } from '../features/sell/publish-page'

export const Route = createFileRoute('/publish')({
  // `edit=<listingId>` 进入编辑模式；不带参数是发布新商品。
  validateSearch: (search: Record<string, unknown>) => ({
    edit: typeof search.edit === 'string' ? search.edit : undefined,
  }),
  component: () => {
    const { edit } = Route.useSearch()
    return <PublishPage editId={edit} />
  },
})
