/**
 * 只接受站内绝对路径，挡掉 open redirect（`//evil.com` 会被浏览器当成协议相对 URL）。
 * 非法输入一律退回首页。
 */
export function sanitizeRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

/** 当前完整路径，作为 `redirect` 的取值来源。 */
export function currentHref(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}
