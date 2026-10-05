/**
 * 加载失败态。
 *
 * 用在「真实接口失败、且没有回退 mock」的页面（生产口径，见 `features/fetchers.ts`）：
 * 这时页面必须说「没加载出来」，而不是给出空态 —— 空态会被读成「恰好没有内容」，
 * 更不能显示 fixture 数据。给一个重试入口，因为多数失败是网络抖动。
 *
 * 传 `kind` 时按失败分类换文案（#304）：401 是「登录已过期」、网络是「网络不可用」、
 * 服务端错误信封（404 / 5xx）是「服务暂时不可用」—— 三种处境不该长成同一句话。
 * 分类判据与文案在 `features/load-failure.ts`，本组件只负责画。
 */
import { Text, View } from '@tarojs/components'
import { type FailureKind, failureCopy } from '@/features/load-failure'
import './index.scss'

type Props = {
  /** 重试：页面把自己的加载函数再跑一遍 */
  onRetry?: () => void
  /**
   * 失败分类。给了就按分类取默认文案；`title` / `text` 一旦显式传入就以显式值为准
   * （既有调用点都显式传，行为不变）。
   */
  kind?: FailureKind
  title?: string
  text?: string
}

export default function LoadError({ onRetry, kind, title, text }: Props) {
  const copy = kind === undefined ? null : failureCopy(kind)
  return (
    <View className="loaderr">
      <Text className="loaderr-title">{title ?? copy?.title ?? '加载失败'}</Text>
      <Text className="loaderr-text">{text ?? copy?.text ?? '检查网络后重试'}</Text>
      {onRetry ? (
        <View className="loaderr-btn" onClick={onRetry}>
          <Text>重试</Text>
        </View>
      ) : null}
    </View>
  )
}
