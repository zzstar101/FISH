import { Image, Text, View } from '@tarojs/components'
import type { ReactNode } from 'react'
import { ICONS } from '@/assets/lib-icons'
import './index.scss'

type EmptyStateProps = {
  title: string
  text: string
  /** 底部行动按钮文案；不传则不渲染按钮 */
  actionText?: string
  onAction?: () => void
  /** 自定义图标（默认用「分类」图标，对应设计稿空货架的语义） */
  icon?: string
  children?: ReactNode
}

export default function EmptyState({
  title,
  text,
  actionText,
  onAction,
  icon = ICONS.category,
}: EmptyStateProps) {
  return (
    <View className="empty">
      <View className="empty__icon">
        <Image className="empty__icon-img" src={icon} mode="aspectFit" />
      </View>
      <Text className="empty__title">{title}</Text>
      <Text className="empty__text">{text}</Text>
      {actionText ? (
        <View className="empty__action" onClick={onAction}>
          <Text>{actionText}</Text>
          <Image className="empty__action-img" src={ICONS.chevronRightMuted} mode="aspectFit" />
        </View>
      ) : null}
    </View>
  )
}
