import { createFileRoute } from '@tanstack/react-router'
import { VerifyPage } from '../features/verify/verify-page'

export const Route = createFileRoute('/verify')({
  component: VerifyPage,
})
