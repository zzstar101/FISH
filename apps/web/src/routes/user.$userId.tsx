import { createFileRoute } from '@tanstack/react-router'
import { UserPage } from '../features/profile/user-page'

export const Route = createFileRoute('/user/$userId')({
  component: () => {
    const { userId } = Route.useParams()
    return <UserPage userId={userId} />
  },
})
