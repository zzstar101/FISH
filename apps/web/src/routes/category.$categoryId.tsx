import { createFileRoute } from '@tanstack/react-router'
import { CategoryPage } from '../features/home/category-page'

export const Route = createFileRoute('/category/$categoryId')({
  component: () => {
    const { categoryId } = Route.useParams()
    return <CategoryPage categoryId={categoryId} />
  },
})
