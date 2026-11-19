import { Image, Text, View } from '@tarojs/components'
import { ICONS } from '@/assets/lib-icons'
import { notificationAppearance, notificationFeed } from '@/features/notifications/presentation'
import { relativeTimeOf } from '@/lib/time'
import type { MockNotification } from '@/mock/types'

function NotificationIcon({ item }: { item: MockNotification }) {
  const appearance = notificationAppearance(item)
  return (
    <View className={`notif__ic is-${appearance.variant}`} aria-hidden>
      <Image className="notif__ic-img" src={ICONS[appearance.icon]} mode="aspectFit" />
      {item.readAt === null ? <View className="notif__dot" /> : null}
    </View>
  )
}

export function NotificationList({
  items,
  unreadCount,
  now,
  onOpen,
}: {
  items: MockNotification[]
  unreadCount: number
  now: number
  onOpen: (item: MockNotification) => void
}) {
  const { featured, groups } = notificationFeed(items, now)
  return (
    <>
      <View className="notif__heading">
        <Text className="notif__heading-title">近期动态</Text>
        <Text className={`notif__unread${unreadCount === 0 ? ' is-clear' : ''}`}>
          {unreadCount > 0 ? `${unreadCount} 条未读` : '全部已读'}
        </Text>
      </View>
      {featured ? (
        <View
          className="notif__featured"
          hoverClass="notif__featured--pressed"
          aria-role="button"
          aria-label={`未读，交易确认邀请，${featured.description}，查看详情`}
          onClick={() => onOpen(featured)}
        >
          <View className="notif__featured-main">
            <NotificationIcon item={featured} />
            <View className="notif__body">
              <View className="notif__featured-top">
                <Text className="notif__body-title">交易确认邀请</Text>
                <Text className="notif__tm num">{relativeTimeOf(featured.createdAt, now)}</Text>
              </View>
              <Text className="notif__text">{featured.description}</Text>
            </View>
          </View>
          <View className="notif__featured-footer">
            <Text className="notif__status is-attention">待查看</Text>
            <View className="notif__cta" aria-hidden>
              <Text>查看详情</Text>
              <Text className="notif__cta-arrow">→</Text>
            </View>
          </View>
        </View>
      ) : null}
      {groups.map((group) => (
        <View key={group.key} className="notif__group">
          <Text className="notif__date">{group.label}</Text>
          <View className="notif__group-card">
            {group.items.map((item) => {
              const appearance = notificationAppearance(item)
              return (
                <View
                  key={item.id}
                  className="notif__item"
                  hoverClass="notif__item--pressed"
                  aria-role="button"
                  aria-label={`${item.readAt === null ? '未读，' : ''}${appearance.title}，${appearance.description}${item.target ? '，查看详情' : '，标记已读'}`}
                  onClick={() => onOpen(item)}
                >
                  <NotificationIcon item={item} />
                  <View className="notif__body">
                    <Text className="notif__body-title">{appearance.title}</Text>
                    {appearance.description ? (
                      <Text className="notif__text">{appearance.description}</Text>
                    ) : null}
                  </View>
                  {appearance.status ? (
                    <Text className={`notif__status is-${appearance.variant}`}>
                      {appearance.status}
                    </Text>
                  ) : null}
                  {item.target ? (
                    <Image
                      className="notif__chevron"
                      src={ICONS.chevronRightMuted}
                      mode="aspectFit"
                      aria-hidden
                    />
                  ) : null}
                </View>
              )
            })}
          </View>
        </View>
      ))}
    </>
  )
}
