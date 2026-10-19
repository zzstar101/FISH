import { createFileRoute } from '@tanstack/react-router'
import { MyDisputesPage } from '../features/disputes/disputes-page'

export const Route = createFileRoute('/disputes/')({ component: MyDisputesPage })
