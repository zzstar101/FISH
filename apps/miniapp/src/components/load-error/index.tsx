/**
 * 加载失败态。
 *
 * 用在「真实接口失败、且没有回退 mock」的页面（生产口径，见 `features/fetchers.ts`）：
 * 这时页面必须说「没加载出来」，而不是给出空态 —— 空态会被读成「恰好没有内容」，
 * 更不能显示 fixture 数据。给一个重试入口，因为多数失败是网络抖动。
 */
import { Text, View } from '@tarojs/components'
import './index.scss'

type Props = {
  /** 重试：页面把自己的加载函数再跑一遍 */
  onRetry?: () => void
  title?: string
  text?: string
}

export default function LoadError({ onRetry, title = '加载失败', text = '检查网络后重试' }: Props) {
  return (
    <View className="loaderr">
      <Text className="loaderr-title">{title}</Text>
      <Text className="loaderr-text">{text}</Text>
      {onRetry ? (
        <View className="loaderr-btn" onClick={onRetry}>
          <Text>重试</Text>
        </View>
      ) : null}
    </View>
  )
}
