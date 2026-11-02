import { useRouter } from '@tarojs/taro'
import LegalDocView from '@/components/legal-doc'
import { isEntryFromAuth } from '@/features/legal/entry'
import { INFO_COLLECTION_DOC } from '@/features/legal/info-collection'

/**
 * 《个人信息收集清单》页面薄壳。
 *
 * 唯一真源：`@/features/legal/info-collection.ts`。
 */
export default function InfoCollectionPage() {
  const router = useRouter()
  return <LegalDocView doc={INFO_COLLECTION_DOC} entry={isEntryFromAuth(router.params)} />
}
