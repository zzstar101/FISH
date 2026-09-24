import { ApiError } from '../../lib/api-client'
import { type FieldErrors, issuesToFieldErrors } from '../../lib/form-errors'

export type AuthFailure = { formError?: string; fieldErrors?: FieldErrors }

/**
 * 错误码 → 用户可读文案，登录与注册共用一份，避免两个页面各写一遍映射。
 *
 * `VALIDATION_FAILED` 在前端已被同一份 zod 契约拦下，能走到这里说明前后端规则漂移：
 * 此时退回服务端 message，而不是假装能定位到某个输入框。
 */
export function describeAuthFailure(error: unknown): AuthFailure {
  if (!(error instanceof ApiError)) return { formError: '网络异常，请稍后重试' }

  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return { formError: '学号或密码错误' }
    case 'STUDENT_NO_TAKEN':
      return { fieldErrors: { studentNo: '该学号已注册，请直接登录' } }
    default:
      return { formError: error.message }
  }
}

/** 表单字段 → 中文标签。只列认证表单实际出现的字段（#86 F 后无 campus）。 */
const FIELD_LABELS: Record<string, string> = {
  nickname: '昵称',
  password: '密码',
  studentNo: '学号',
}

type IssueLike = {
  path: PropertyKey[]
  message: string
  code?: string
  inclusive?: boolean
  minimum?: number | bigint
  maximum?: number | bigint
}

/**
 * zod issue → 中文文案。
 *
 * 契约 schema 只给部分规则写了 message（如 `学号必须是 12 位数字`），长度上下限、必填、
 * 枚举这些用的是 zod 默认英文（`Too small: expected string to have >=8 characters`）。
 * `packages/contracts` 归 auth domain owner，前端不改它，所以在这里按 issue code 兜底；
 * 契约自带消息的规则走 default 分支，沿用契约原文，不在前端重写一遍规则。
 */
function localizeIssue(issue: IssueLike, label: string): string {
  switch (issue.code) {
    case 'too_small':
      return issue.inclusive === false
        ? `${label}需要多于 ${String(issue.minimum)} 个字符`
        : `${label}至少 ${String(issue.minimum)} 个字符`
    case 'too_big':
      return issue.inclusive === false
        ? `${label}需要少于 ${String(issue.maximum)} 个字符`
        : `${label}最多 ${String(issue.maximum)} 个字符`
    case 'invalid_type':
      return `请填写${label}`
    case 'invalid_value':
      return `请选择有效的${label}`
    default:
      return issue.message
  }
}

/** 与 `issuesToFieldErrors` 同义，但先把 zod 的默认英文文案换成本地文案。 */
export function toAuthFieldErrors(issues: ReadonlyArray<IssueLike>): FieldErrors {
  return issuesToFieldErrors(
    issues.map((issue) => {
      const field = issue.path[0]
      const label = typeof field === 'string' ? FIELD_LABELS[field] : undefined
      return {
        message: label === undefined ? issue.message : localizeIssue(issue, label),
        path: issue.path,
      }
    }),
  )
}
