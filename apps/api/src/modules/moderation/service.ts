import { moderateListingContent } from './rules'
import type { ModerationResult } from './types'

export interface ModerationService {
  moderate(input: { title: string; description: string }): ModerationResult
}

export function createModerationService(): ModerationService {
  return { moderate: moderateListingContent }
}
