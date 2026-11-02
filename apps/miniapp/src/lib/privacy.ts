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

/** 一次隐私查询的结果：授权、明确拒绝、或状态未知（失败/超时/API 缺失）。 */
export type PrivacyAuthorizationState = 'authorized' | 'denied' | 'unknown'

/** 查 `getPrivacySetting` 的兜底：桥接不回调时不能把语音按钮永久卡住。 */
const PRIVACY_QUERY_TIMEOUT_MS = 5_000
/** 官方授权弹窗由用户操作，给更长的兜底时间。 */
const PRIVACY_AUTHORIZE_TIMEOUT_MS = 30_000

/**
 * 查询一次隐私授权状态。
 *
 * `unknown` 与 `denied` 必须分开：前者是查询失败/超时，用户按「去同意」也恢复不了；
 * 后者才是用户明确拒绝。调用方据此给不同文案（#526 审查）。
 */
function queryPrivacyAuthorization(): Promise<PrivacyAuthorizationState> {
  // 老基础库没有这个 API：平台不做隐私检查，不能把用户挡在门外。
  if (typeof Taro.getPrivacySetting !== 'function') return Promise.resolve('authorized')

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (state: PrivacyAuthorizationState) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(state)
    }

    const armTimeout = (ms: number, message: string) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (settled) return
        console.warn(message)
        settle('unknown')
      }, ms)
    }

    armTimeout(PRIVACY_QUERY_TIMEOUT_MS, '[privacy] getPrivacySetting 超时，授权状态未知')

    try {
      Taro.getPrivacySetting({
        success: (setting) => {
          if (!setting.needAuthorization) {
            settle('authorized')
            return
          }
          if (typeof Taro.requirePrivacyAuthorize !== 'function') {
            console.warn('[privacy] requirePrivacyAuthorize 不可用，授权状态未知')
            settle('unknown')
            return
          }
          armTimeout(
            PRIVACY_AUTHORIZE_TIMEOUT_MS,
            '[privacy] requirePrivacyAuthorize 超时，授权状态未知',
          )
          try {
            Taro.requirePrivacyAuthorize({
              success: () => settle('authorized'),
              fail: (error) => {
                console.warn('[privacy] requirePrivacyAuthorize 未通过', error)
                settle('denied')
              },
            })
          } catch (error) {
            // 回调式 API 在异常时可能既不 success 也不 fail；同步异常必须自己收口，
            // 否则 Promise 永远不 settle，调用方的 finally 不会执行（#526 审查）。
            console.warn('[privacy] requirePrivacyAuthorize 异常', error)
            settle('unknown')
          }
        },
        fail: (error) => {
          console.warn('[privacy] getPrivacySetting 失败，授权状态未知', error)
          settle('unknown')
        },
      })
    } catch (error) {
      console.warn('[privacy] getPrivacySetting 异常，授权状态未知', error)
      settle('unknown')
    }
  })
}

/** 查询隐私授权状态（三态）；同一个页面可据此区分「拒绝」与「查不到」。 */
export function getPrivacyAuthorizationState(): Promise<PrivacyAuthorizationState> {
  return queryPrivacyAuthorization()
}

/**
 * 确保用户已同意隐私协议（头像等 #86 既有入口）。
 *
 * 授权状态查询失败时返回 `true`（fail-open）：这是本函数的历史契约，头像页在挂载时
 * 就消费结果，fail-closed 会让一次桥接异常直接弹「需同意隐私保护指引」。
 * 语音路径不用这个「布尔」口径：它要区分「用户拒绝」与「查不到」，用
 * {@link getPrivacyAuthorizationState} + {@link canEnterVoiceMode}（fail-closed）。
 */
export async function ensurePrivacyAuthorized(): Promise<boolean> {
  return (await queryPrivacyAuthorization()) !== 'denied'
}

/**
 * 语音 gate 的纯判据：授权明确通过、代次没被新操作覆盖、页面还活着，三者缺一不可。
 *
 * 抽成纯函数是为了让「未授权 / 旧代次 / 已离页都不得进入语音态」有行为级回归测试，
 * 不再只靠源码字符串断言（#526 审查）。
 */
export function canEnterVoiceMode(
  state: PrivacyAuthorizationState,
  seq: number,
  currentSeq: number,
  alive: boolean,
): boolean {
  return state === 'authorized' && seq === currentSeq && alive
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
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      console.warn('[privacy] requirePrivacyAuthorize 超时，授权未完成')
      resolve(false)
    }, PRIVACY_AUTHORIZE_TIMEOUT_MS)
    const settle = (authorized: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(authorized)
    }
    try {
      Taro.requirePrivacyAuthorize({
        success: () => settle(true),
        fail: (error) => {
          console.warn('[privacy] requirePrivacyAuthorize 未通过', error)
          settle(false)
        },
      })
    } catch (error) {
      console.warn('[privacy] requirePrivacyAuthorize 异常', error)
      settle(false)
    }
  })
}
