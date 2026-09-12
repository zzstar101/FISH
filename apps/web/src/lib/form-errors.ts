/** 字段名 → 行内错误文案。字段名与契约 schema 的 `path[0]` 一致，可直接喂给表单。 */
export type FieldErrors = Record<string, string>

/**
 * 把 zod 的 issues 收敛成「每个字段只留第一条」。表单一屏只展示一条提示，
 * 多条会互相打架；而 zod 的 issue 顺序已是声明顺序，取首条即最贴近输入的规则。
 *
 * 结构化入参而非 `ZodError`，是为了让 web 侧不必直接依赖 `zod`（它不在 `apps/web` 的依赖里）。
 */
export function issuesToFieldErrors(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): FieldErrors {
  const errors: FieldErrors = {}
  for (const issue of issues) {
    const field = issue.path[0]
    if (typeof field === 'string' && errors[field] === undefined) errors[field] = issue.message
  }
  return errors
}
