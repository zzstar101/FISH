/**
 * 扫码登录的「登录后回确认页」续接判定（Taro-free，可单测）。
 *
 * 扫码确认页（#197）在未登录时带 `back=pages/login-confirm/index&ticket=<票据>` 跳到登录页；
 * 登录成功后本函数判定这次登录是否要**原路回确认页**，并给出续接用的票据。
 *
 * **必须先解码再比较**：微信 `navigateTo` 不替调用方解码 query（#252 实测，见
 * `@/lib/route-param`），确认页按仓库惯例用 `encodeURIComponent` 拼 `back`，真机上
 * 到手的是 `pages%2Flogin-confirm%2Findex` —— 拿原样串精确比较会恒为 false，
 * 续接链路静默断裂（H5 预览的路由会解码，测不出这个差别）。
 *
 * @returns 续接用的票据；不续接（不是从确认页来的 / 没带票据）返回 null，登录后照常回首页。
 */
import { routeParam } from '@/lib/route-param'

const LOGIN_CONFIRM_ROUTE = 'pkg-auth/pages/login-confirm/index'

export function confirmBackTicket(
  back: string | undefined,
  ticket: string | undefined,
): string | null {
  if (routeParam(back) !== LOGIN_CONFIRM_ROUTE) return null
  const decoded = routeParam(ticket)
  return decoded === '' ? null : decoded
}
