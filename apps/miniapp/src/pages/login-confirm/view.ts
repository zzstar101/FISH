/**
 * 扫码登录确认页的**纯逻辑**：启动参数解析。
 *
 * 页面有两个预期入口（#197，后端未合入，链路未通）：
 * - 电脑端出的是**小程序码**时，微信扫码直接拉起本页，票号在 `scene` 里。
 *   scene 先按百分号编码解码，再认 `t=<ticket>` 形状 —— 这是**临时约定**，
 *   #197 冻结契约后以其为准，不提前把格式焊死到别处；
 * - 开发者工具演示 / 未来页内跳转用显式 `ticket` 参数。
 *
 * 两个入口都取不到票号时返回 null，页面落「无效登录码」态。
 */
export type LoginLaunch = { ticket: string }

export function parseLoginLaunch(params: Record<string, string | undefined>): LoginLaunch | null {
  const direct = params.ticket?.trim()
  if (direct) return { ticket: direct }
  const scene = params.scene
  if (!scene) return null
  let decoded = scene
  try {
    decoded = decodeURIComponent(scene)
  } catch {
    // 场景值不是合法百分号编码：按原样继续解析
  }
  if (!decoded.startsWith('t=')) return null
  const ticket = decoded.slice(2).trim()
  return ticket ? { ticket } : null
}
