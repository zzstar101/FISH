/**
 * 多步上传链的在途判据（#170 复查 #208）。
 *
 * 单独一个叶子模块：`./api` 会拉进 Taro 与会话层，而这里的语义是纯的
 * （「这一步还该不该发」），可以脱离平台单测 —— 与 `./choose-error` 同一手法。
 */

/**
 * 多步上传链「起步时的账号已经不在了」的中止信号。
 *
 * 与普通上传失败分开：页面据此**什么都不做**（既不写状态也不提示），因为这次上传
 * 已经不属于当前账号 / 当前这次进入 —— 复用失败文案只会让用户看到一条莫名其妙的报错。
 */
export class UploadAbortedError extends Error {
  constructor() {
    super('图片上传已中止')
    this.name = 'UploadAbortedError'
  }
}

/**
 * 多步链每一步发请求前的在途检查。
 *
 * 为什么必须逐步检查：页面里的 `taskAlive(task)` 只在 `uploadListingImage()` **整体返回
 * 之后**跑，那是写状态的守卫；而那条链是 presign → 直传 PUT → confirm 三步，后两步会照常
 * 发出。`apiRequest` 的 Cookie 是**调用那一刻**从会话现取的（`lib/request.ts`），所以切号后
 * confirm 会带着**新账号**的会话发出去（服务端按 objectKey 前缀拒成 422；登出后是 401），
 * PUT 还会在对象存储里落下一个没人引用的对象。换号 / 卸载后不该再发任何一次鉴权请求。
 *
 * 要不要真的取消正在飞的那一次？`Taro.request` 没接 AbortController，做不到 —— 这里只保证
 * 「还没发的」不再发。传 `undefined`（不关心归属）时保持旧行为。
 */
export function assertUploadActive(isActive?: () => boolean): void {
  if (isActive && !isActive()) throw new UploadAbortedError()
}
