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
 *   不该把用户挡在门外；只有用户明确拒绝才返回 `false`。
 */
export function ensurePrivacyAuthorized(): Promise<boolean> {
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
            fail: () => resolve(false),
          })
        },
        // 查询失败：不阻断，交给平台在真正调用隐私接口时处理
        fail: () => resolve(true),
      })
    } catch {
      resolve(true)
    }
  })
}
