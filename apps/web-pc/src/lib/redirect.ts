/**
 * 只接受规范化为 `/pc` 下的站内绝对路径，挡掉 absolute URL、protocol-relative
 * URL 和 `/pc/../admin` 这类规范化后会逃出 PC 应用的路径。
 *
 * 登录 / 注册页不允许作为回跳目标：否则登录成功后可能再次落回登录页。
 */
export function sanitizeRedirect(value: unknown): string {
  if (typeof value !== 'string') return '/pc/'

  let url: URL
  try {
    url = new URL(value, 'https://pc.invalid')
  } catch {
    return '/pc/'
  }

  if (url.origin !== 'https://pc.invalid') return '/pc/'

  const canonicalPath = url.pathname.replace(/\/+$/, '') || '/'
  const isPcPath = canonicalPath === '/pc' || canonicalPath.startsWith('/pc/')
  if (!isPcPath) return '/pc/'
  if (canonicalPath === '/pc') return `/pc/${url.search}${url.hash}`
  if (canonicalPath === '/pc/login' || canonicalPath === '/pc/register') return '/pc/'

  return `${url.pathname}${url.search}${url.hash}`
}

/** 当前完整路径，作为 `redirect` 的取值来源。 */
export function currentHref(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}
