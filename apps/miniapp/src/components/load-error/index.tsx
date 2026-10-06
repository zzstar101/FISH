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
   * 失败分类。给了就按分类取默认文案；`title` / `text` 一旦显式传入就以显式值为准。
   *
   * 这两个文案**不必**由调用点传：不传就沿用 `'加载失败'` / `'检查网络后重试'`
   * 这对默认值。调用点三种写法都有，照实列：
   * - 只给 `onRetry`（走默认值）：`pages/home`、`pages/chat`（通知 / 会话两处）、
   *   `pkg-browse/pages/search`、`pkg-browse/pages/following`；
   * - 给 `kind` 且**条件**给 `text`：`components/order-list`（列表还在时写「以下为上次
   *   加载的订单」，此时既不取默认值、也不取分类文案）；
   * - 显式传一个或两个：其余调用点（如 `pkg-browse/pages/history` 传 title + text、
   *   `pages/sell` 只给 text、`pkg-browse/pages/user` 只给 title）。
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
