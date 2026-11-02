import { useRouter } from '@tarojs/taro'
import LegalDocView from '@/components/legal-doc'
import { COMMUNITY_GUIDELINES_DOC } from '@/features/legal/community-guidelines'
import { isEntryFromAuth } from '@/features/legal/entry'

/**
 * 《社区规范与交易安全须知》页面薄壳。
 *
 * 唯一真源：`@/features/legal/community-guidelines.ts`。
 */
export default function CommunityGuidelinesPage() {
  const router = useRouter()
  return <LegalDocView doc={COMMUNITY_GUIDELINES_DOC} entry={isEntryFromAuth(router.params)} />
}
