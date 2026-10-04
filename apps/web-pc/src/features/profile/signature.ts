import { SignatureSchema } from '@fish/contracts/profile/schema'

/**
 * 编辑资料弹窗里「个性签名」输入的准备（#179 契约语义的端上落地）：
 *
 * - **trim 后与原值一致 → unchanged**：不给 `PATCH /profile` 发无意义的签名写入
 *   （契约要求至少一项，签名没变时不该由它撑起一次请求）；
 * - **超长 → error**：消息取自契约 `SignatureSchema`，与 422 的服务端文案同源；
 * - **空串 = 清空**：原值非空而输入只有空白时，`value: ''` 是刻意的 —— 契约把
 *   trim 后空串归一化为「清空」，不能用缺省冒充。
 */
export function prepareSignatureInput(
  raw: string,
  original: string | null,
):
  | { status: 'unchanged' }
  | { status: 'error'; message: string }
  | { status: 'ok'; value: string } {
  const next = raw.trim()
  if (next === (original ?? '')) return { status: 'unchanged' }

  const parsed = SignatureSchema.safeParse(next)
  if (!parsed.success) {
    return {
      status: 'error',
      message: parsed.error.issues[0]?.message ?? '个性签名格式不正确',
    }
  }
  return { status: 'ok', value: next }
}

/**
 * 展示口径：**取首行**。契约允许换行存原文，小程序按 `signatureFirstLine` 只展示首行，
 * PC 与它对齐 —— HTML 里直接渲染原文会把换行折叠成连排文字，两端看到的不是同一句话。
 */
export function signatureFirstLine(signature: string): string {
  return signature.split('\n')[0] ?? ''
}
