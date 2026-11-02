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
 * 查询一次隐私授权状态。
 *
 * - `true`：已授权，或平台/老基础库不做隐私检查；
 * - `false`：用户明确拒绝；
 * - `null`：查询过程失败，状态未知。
 *
 * 单独拆出来是因为调用方对「未知」的处理不同：头像页按历史行为 fail-open，
 * 语音录音必须 fail-closed（#516），不能共用同一个布尔投影。
 */
function queryPrivacyAuthorization(): Promise<boolean | null> {
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
          if (typeof Taro.requirePrivacyAuthorize !== 'function') {
            console.warn('[privacy] requirePrivacyAuthorize 不可用，授权状态未知')
            resolve(null)
            return
          }
          try {
            Taro.requirePrivacyAuthorize({
              success: () => resolve(true),
              fail: (error) => {
                console.warn('[privacy] requirePrivacyAuthorize 未通过', error)
                resolve(false)
              },
            })
          } catch (error) {
            // 回调式 API 在异常时可能既不 success 也不 fail；同步异常必须自己收口，
            // 否则 Promise 永远不 settle，调用方的 finally 不会执行（#526 审查）。
            console.warn('[privacy] requirePrivacyAuthorize 异常', error)
            resolve(null)
          }
        },
        fail: (error) => {
          console.warn('[privacy] getPrivacySetting 失败，授权状态未知', error)
          resolve(null)
        },
      })
    } catch (error) {
      console.warn('[privacy] getPrivacySetting 异常，授权状态未知', error)
      resolve(null)
    }
  })
}

/**
 * 确保用户已同意隐私协议（头像等 #86 既有入口）。
 *
 * 授权状态查询失败时返回 `true`（fail-open）：这是本函数的历史契约，头像页在挂载时
 * 就消费结果，fail-closed 会让一次桥接异常直接弹「需同意隐私保护指引」。
 * 语音录音需要严格的 fail-closed，请用 {@link ensurePrivacyAuthorizedStrict}。
 */
export async function ensurePrivacyAuthorized(): Promise<boolean> {
  return (await queryPrivacyAuthorization()) !== false
}

/**
 * 严格版：只有明确「已授权/平台不检查」才放行，查询失败按拒绝处理。
 *
 * 语音录音使用此版本：授权状态未知时不能启动录音，否则用户会以为在录、实际被平台静默拦下。
 */
export async function ensurePrivacyAuthorizedStrict(): Promise<boolean> {
  return (await queryPrivacyAuthorization()) === true
}

/**
 * 直接拉起一次官方隐私授权弹窗（语音失败后的「去授权」入口）。
 *
 * 不复用 `getPrivacySetting`：录音机已经明确报 privacy errMsg 时，即使
 * `needAuthorization` 因 MP 后台未声明而恒为 false，也要让用户看到一次授权结果。
 */
export function requestPrivacyAuthorize(): Promise<boolean> {
  if (typeof Taro.requirePrivacyAuthorize !== 'function') return Promise.resolve(false)
  return new Promise((resolve) => {
    try {
      Taro.requirePrivacyAuthorize({
        success: () => resolve(true),
        fail: (error) => {
          console.warn('[privacy] requirePrivacyAuthorize 未通过', error)
          resolve(false)
        },
      })
    } catch (error) {
      console.warn('[privacy] requirePrivacyAuthorize 异常', error)
      resolve(false)
    }
  })
}
