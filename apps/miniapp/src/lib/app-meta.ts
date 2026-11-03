import Taro from '@tarojs/taro'

/** 读取当前运行包的微信版本；开发/预览环境不能用仓内常量冒充发布版本。 */
export function readAppVersion(): string {
  try {
    const miniProgram = Taro.getAccountInfoSync()?.miniProgram
    if (miniProgram?.envVersion === 'develop') return '开发版'
    const version = miniProgram?.version?.trim()
    if (miniProgram?.envVersion === 'trial') {
      return version ? `v${version}（体验版）` : '体验版'
    }
    return version ? `v${version}` : '版本未知'
  } catch {
    // H5 预览或旧运行环境可能没有此 API；不让元信息影响页面可用性。
    return '版本未知'
  }
}
