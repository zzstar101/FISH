import { createFileRoute } from '@tanstack/react-router'
import { MyListPage, type MyListType } from '../features/profile/mylist-page'

const TYPES: MyListType[] = ['post', 'active', 'fav', 'sold', 'bought', 'history', 'follow']

export const Route = createFileRoute('/mylist')({
  validateSearch: (search: Record<string, unknown>) => ({
    type: TYPES.includes(search.type as MyListType) ? (search.type as MyListType) : 'post',
  }),
  component: () => {
    const { type } = Route.useSearch()
    return <MyListPage type={type} />
  },
})
