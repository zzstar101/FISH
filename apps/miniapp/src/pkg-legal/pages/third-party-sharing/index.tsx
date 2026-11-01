import { useRouter } from '@tarojs/taro'
import LegalDocView from '@/components/legal-doc'
import { isEntryFromAuth } from '@/features/legal/entry'
import { THIRD_PARTY_SHARING_DOC } from '@/features/legal/third-party-sharing'

/**
 * 《第三方信息共享清单》页面薄壳。
 *
 * 唯一真源：`@/features/legal/third-party-sharing.ts`。
 */
export default function ThirdPartySharingPage() {
  const router = useRouter()
  return <LegalDocView doc={THIRD_PARTY_SHARING_DOC} entry={isEntryFromAuth(router.params)} />
}
