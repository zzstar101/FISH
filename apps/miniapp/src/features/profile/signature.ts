/**
 * 个性签名：本机存储 + 展示口径。
 *
 * 契约的 `Me`（`packages/contracts/src/auth/user.ts`）至今没有签名字段，后端也没有
 * 读写端点，所以「真实输入并保存」这一步先落在本机：**按账号 id 分键**存 `Taro`
 * 存储，换账号不会读到上一个人的签名。等后端补了字段，把这两个函数换成 `GET /me`
 * 与写接口即可 —— 页面的读写调用不用动。
 *
 * 存储调用一律包 try/catch（与 `lib/session.ts` / `pages/settings` 同口径）：
 * 读失败按「没设置」处理（不让一次本地读取把整页打挂），写失败如实回传由页面提示。
 */
import Taro from '@tarojs/taro'

/** 存储键按账号分；命名与既有的 `fish:session` / `fish:settings` 一致 */
function signatureKey(userId: string): string {
  return `fish:profile-signature:${userId}`
}

/** 读签名；未设置过（或已被清空）返回 `null`，页面据此显示「设置个性签名」占位 */
export function readSignature(userId: string): string | null {
  try {
    const raw: unknown = Taro.getStorageSync(signatureKey(userId))
    return typeof raw === 'string' && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

/**
 * 保存签名；空输入 = 清除（回到「设置个性签名」占位）。
 * 返回**是否写入成功** —— 存储写失败时页面要如实提示，不能假装保存成功。
 */
export function saveSignature(userId: string, text: string): boolean {
  const trimmed = text.trim()
  try {
    if (trimmed.length === 0) {
      Taro.removeStorageSync(signatureKey(userId))
      return true
    }
    Taro.setStorageSync(signatureKey(userId), trimmed)
    return true
  } catch {
    return false
  }
}
