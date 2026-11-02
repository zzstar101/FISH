/**
 * 发布前绑定手机号的底部弹层（#514，出物页 / 许愿页共用）。
 *
 * 只负责画：授权回调与绑定编排在 `@/features/auth/use-phone-bind`，由页面把 `binding` /
 * `onGetPhoneNumber` 透传进来 —— 那个 hook 依赖页面生命周期，必须在页面组件里调用。
 *
 * 按钮必须是原生 `<Button openType="getPhoneNumber">`：手机号授权只能由用户点这个原生按钮触发，
 * 自绘 `View` 拿不到 code。
 */
import { Button, Text, View } from '@tarojs/components'
import type { PhoneNumberEvent } from '@/features/auth/use-phone-bind'
import './index.scss'

type Props = {
  open: boolean
  /** 绑定请求飞行中：按钮显示「绑定中…」并禁用，遮罩 / 取消也不关（避免结果回来时 sheet 已不在） */
  binding: boolean
  onGetPhoneNumber: (event: PhoneNumberEvent) => void
  onClose: () => void
}

export default function PhoneBindSheet({ open, binding, onGetPhoneNumber, onClose }: Props) {
  if (!open) return null
  const close = () => {
    if (!binding) onClose()
  }
  return (
    <>
      <View className="pbs__scrim" onClick={close} />
      <View className="pbs">
        <Text className="pbs__title">发布前需绑定手机号</Text>
        <Text className="pbs__text">
          为保障交易安全，发布前需要先绑定手机号。点下方按钮通过微信授权即可完成，绑定后再点一次发布。
        </Text>
        <View className="pbs__acts">
          <View className="pbs__cancel" onClick={close}>
            <Text>暂不绑定</Text>
          </View>
          <Button
            className={`pbs__ok${binding ? ' is-off' : ''}`}
            openType="getPhoneNumber"
            disabled={binding}
            onGetPhoneNumber={onGetPhoneNumber}
          >
            {binding ? '绑定中…' : '绑定手机号'}
          </Button>
        </View>
      </View>
    </>
  )
}
