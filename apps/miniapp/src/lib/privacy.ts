/**
 * 微信隐私授权（#86 B 线）：`open-type="chooseAvatar"` 属于微信的隐私接口，
 * 用户没同意过《用户隐私保护指引》时调用会被基础库拦下
 * （`chooseAvatar:fail privacy permission is not authorized`）。
 *
 * 真正的前置在 mp 后台：「设置 → 服务内容声明 → 用户隐私保护指引」里必须声明头像等收集类型。
 * 没声明时 `getPrivacySetting` 的 `needAuthorization` 恒为 false，本函数就是空操作；
 * 声明了、且用户还没同意过，才会弹官方授权弹窗。
 *
 * 用回调式 API：Taro 把 `getPrivacySetting` / `requirePrivacyAuthorize` 声明为 `void`，
 * 不保证返回 Promise。
 */
import Taro from '@tarojs/taro'

/**
 * 确保用户已同意隐私协议。
 *
 * @returns 用户是否已同意。接口不可用（老基础库）时返回 `true` —— 那种情况下平台不做隐私检查，
 *   不该把用户挡在门外；用户拒绝、或授权状态查询失败/异常时返回 `false`（不拿未知状态冒险）。
 */
export function ensurePrivacyAuthorized(): Promise<boolean> {
  // 老基础库没有这个 API：平台不做隐私检查，不能把用户挡在门外。
  if (typeof Taro.getPrivacySetting !== 'function') return Promise.resolve(true)

  return new Promise((resolve) => {
    try {
      Taro.getPrivacySetting({
        success: (setting) => {
          if (!setting.needAuthorization) {
            resolve(true)
            return
          }
          Taro.requirePrivacyAuthorize({
            success: () => resolve(true),
            fail: (error) => {
              console.warn('[privacy] requirePrivacyAuthorize 未通过', error)
              resolve(false)
            },
          })
        },
        // 查询失败不等于用户拒绝，但也不能当作已授权：授权状态未知时宁可让用户重试。
        fail: (error) => {
          console.warn('[privacy] getPrivacySetting 失败，拒绝继续', error)
          resolve(false)
        },
      })
    } catch (error) {
      console.warn('[privacy] getPrivacySetting 异常，拒绝继续', error)
      resolve(false)
    }
  })
}
