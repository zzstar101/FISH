/**
 * 交易进度卡（#521 / #522）。
 *
 * 「跟会话里的交易码卡一个底座」是 Owner 的原话：这里直接复用 `.conv__txcard*`
 * 那套类，只换图标、标题、说明与 CTA 的文案/跳转 —— 状态变化时用户看到的是
 * **同一张卡在变**，不是每来一条消息就换一种卡片。
 *
 * 渲染位置由调用方决定：当前是模式①（吸附在输入栏上方，长期显示）；如果之后
 * 觉得太占地方，改成模式②（每次状态变化作为一条消息出现）只需要挪挂载点，
 * 卡片本身与 `view.ts` 的 `txCardView` 判定都不用动。
 */
import { Image, Text, View } from '@tarojs/components'
import { ICONS } from '@/assets/lib-icons'
import type { TxCardView } from './view'

const TX_CARD_ICON = {
  qr: ICONS.qr,
  clock: ICONS.clockInk,
  check: ICONS.checkCircle,
  close: ICONS.closeInk,
} as const

type TxCardProps = {
  view: TxCardView
  onAction: () => void
}

export function TxCard({ view, onAction }: TxCardProps) {
  return (
    <View className={`conv__txcard conv__txcard--dock ${view.tone}`}>
      <Image className="conv__txcard-ic" src={TX_CARD_ICON[view.icon]} mode="aspectFit" />
      <View className="conv__txcard-main">
        <Text className="conv__txcard-t">{view.title}</Text>
        <Text className="conv__txcard-d">{view.desc}</Text>
      </View>
      <View className="conv__txcard-act" onClick={onAction}>
        <Text>{view.actionLabel}</Text>
      </View>
    </View>
  )
}
