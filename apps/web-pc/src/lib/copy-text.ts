/**
 * 写剪贴板。失败（非安全上下文 / 权限被拒）返回 false，由调用方决定提示文案；
 * 编号是给人看的公开引用，复制失败时用户仍可手动选中复制。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
