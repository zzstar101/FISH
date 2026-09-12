import { createFileRoute } from '@tanstack/react-router'
import { PublishPage } from '../features/sell/publish-page'

/** `edit` 必须是可选：标成必填会让 `<Link to="/publish">` 也要求传 search（同 login 路由）。 */
type PublishSearch = { edit?: string }

export const Route = createFileRoute('/publish')({
  // `edit=<listingId>` 进入编辑模式；不带参数是发布新商品。
  validateSearch: (search: Record<string, unknown>): PublishSearch => ({
    edit: typeof search.edit === 'string' ? search.edit : undefined,
  }),
  component: () => {
    const { edit } = Route.useSearch()
    return <PublishPage editId={edit} />
  },
})
