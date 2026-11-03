import Taro from '@tarojs/taro'

declare const __APP_VERSION__: string | undefined

/** 微信实际版本优先；开发/体验包未返回版本时使用与上传版本同源的构建值。 */
export function readAppMeta(
  buildVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',
): { version: string; environment: '开发版' | '体验版' | null } {
  const fallback = buildVersion.trim() || '版本未知'
  try {
    const miniProgram = Taro.getAccountInfoSync()?.miniProgram
    return {
      version: miniProgram?.version?.trim() || fallback,
      environment:
        miniProgram?.envVersion === 'develop'
          ? '开发版'
          : miniProgram?.envVersion === 'trial'
            ? '体验版'
            : null,
    }
  } catch {
    // H5 预览或旧环境可能没有此 API；不让元信息影响页面可用性。
    return { version: fallback, environment: null }
  }
}
