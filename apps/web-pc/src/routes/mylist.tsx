import { createFileRoute } from '@tanstack/react-router'
import { MyListPage } from '../features/profile/mylist-page'

export const Route = createFileRoute('/mylist')({
  component: MyListPage,
})
