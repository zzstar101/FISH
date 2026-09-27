/**
 * 路由 query 取值。
 *
 * 微信 `navigateTo` **不会**替调用方解码 query，`Taro.useRouter().params` 拿到的就是 URL 里
 * 那一串原样字符串；而跳转方按仓库惯例用 `encodeURIComponent` 拼参数（中文标题、昵称、
 * 空格都会变 `%E7%BD%97%E6%8A%80%20K380` 这种形状）。所以消费方必须解一次，否则页面会把
 * 百分号编码原样渲染给用户 —— #252 端上联调在举报填写页的「被举报对象」卡上实测到过。
 *
 * 解码失败（不是合法百分号编码，比如用户手改链接）就按原样返回，交给下游自己的形状校验，
 * 与 `pages/login-confirm/view.ts` 的 `fromScene` 同一取舍。
 */
export function routeParam(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
