import { Alert, AlertDescription, AlertTitle } from '@fish/ui/alert'
import { Smartphone } from 'lucide-react'

/** 路径以小程序源码为准：Tab「我的」→「设置」行 → 设置页「手机号」行的「绑定」按钮。 */
const PHONE_REQUIRED_GUIDE =
  '发布商品或求购愿望前需绑定手机号 —— 请打开微信小程序「鱼小应」→「我的」→「设置」→「手机号」，点「绑定」完成授权，回到本页即可继续。'

/**
 * 「发布前需绑定手机号」引导（#514）。PC 端拿不到微信手机号（`getPhoneNumber` 是小程序专有），
 * 只能把用户指到小程序设置页；PC 登录只有扫小程序码一条路，所以每个 PC 用户都有小程序账号。
 * 服务端对未绑定账号的 `POST /listings` / `POST /wishes` 回 403 `PHONE_REQUIRED`（客户端
 * `me.phoneBound` 可能过期），调用方收到该错误码时也渲染本卡片。
 *
 * 不给「重新检查」按钮：`useMe` 是 `refetchOnWindowFocus: 'always'`，用户在手机上绑完、
 * 切回本标签页时 `/me` 会重拉，`phoneBound` 变为 true 后调用方自然不再渲染本卡片。
 */
export function PhoneRequiredNotice({ className }: { className?: string }) {
  return (
    <Alert className={className}>
      <Smartphone />
      <AlertTitle>需要先绑定手机号</AlertTitle>
      <AlertDescription>
        <p>{PHONE_REQUIRED_GUIDE}</p>
      </AlertDescription>
    </Alert>
  )
}
