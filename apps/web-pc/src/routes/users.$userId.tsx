import { createFileRoute } from '@tanstack/react-router'
import { UserProfilePage } from '../features/user-profile/user-profile-page'

export const Route = createFileRoute('/users/$userId')({ component: UserProfileRoute })

function UserProfileRoute() {
  const { userId } = Route.useParams()
  // 换用户时重挂载：查询键虽然带 userId，但页面内的一次性状态不该跨用户复用。
  return <UserProfilePage key={userId} userId={userId} />
}
