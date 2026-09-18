import { createFileRoute } from '@tanstack/react-router'
import { VerificationPage } from '../features/profile/verification-page'

export const Route = createFileRoute('/profile/verification')({ component: VerificationPage })
