import { Text, View } from '@tarojs/components'
import { BACKEND_STATUS } from '@/lib/contracts'
import type { TabPageKey } from '@/types/tab'
import './index.scss'

type DevPlaceholderProps = {
  page: TabPageKey
  title: string
}

/** 骨架阶段的统一占位：只展示页面名称、产品名与开发状态。 */
export default function DevPlaceholder({ page, title }: DevPlaceholderProps) {
  return (
    <View className="dev-placeholder">
      <Text className="dev-placeholder__title">{title}</Text>
      <Text className="dev-placeholder__brand">FISH Miniapp</Text>
      <Text className="dev-placeholder__status">
        {`开发占位 · ${page} · 后端契约状态 ${BACKEND_STATUS}`}
      </Text>
    </View>
  )
}
