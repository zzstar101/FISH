import { createFileRoute } from '@tanstack/react-router'
import { WishPage } from '../features/wish/wish-page'

export const Route = createFileRoute('/wish')({ component: WishPage })
