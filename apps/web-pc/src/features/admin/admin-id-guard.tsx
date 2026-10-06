/**
 * URL 里公开 ID 的形态守卫（#467 五审 P0）。
 *
 * 列表页的筛选条件都写在 URL 里，用户（或一条旧书签）可能给出不是公开 ID 的串。
 * 服务端对这类参数返回 422，而页面把 `isError` 当「加载失败」整页早返回——筛选区连同
 * 「清除」一起消失，坏参数把人锁死在错误页里。这里的纪律是：**非法值不进 filters、
 * 不发服务端**，但留在 URL 里回显成红色提示并给清除入口。
 *
 * 该模式先在交易页落地（#467 二审 S1），第五轮抽成共用件，四个带 ID 筛选的列表页
 * （交易/商品/审核记录/审计）共用同一套判定与提示。
 */

/** 一个可筛选的公开 ID 字段：展示名 + 前缀（只用于文案）+ 契约 schema（只用到 safeParse）。 */
export type PublicIdSpec = {
  label: string
  /** 提示文案里的前缀；审计的目标 ID 随资源类型变，可以是多个候选的说明串。 */
  prefix: string
  /** 契约 schema 的结构化签名：web-pc 不直接依赖 zod（见 `admin-search.ts` 同口径）。 */
  schema: { safeParse(value: unknown): { success: boolean } }
}

export type RejectedPublicId = { field: string; label: string; prefix: string; raw: string }

export type PublicIdCheck<F extends string> = {
  /** 通过契约 schema 的 ID：只有这些进 filters（即只有这些会发给服务端）。 */
  valid: Partial<Record<F, string>>
  /** 形态不合法的 ID：留在 URL 里原样回显，但绝不进 filters。 */
  rejected: RejectedPublicId[]
}

/**
 * 按契约 schema 分流：合法 → `valid`，形态不对 → `rejected`（空值直接跳过）。
 *
 * 字段集合只从 `specs` 推出（`values` 的键位刻意写成 `string`）：调用方传的是整份 search
 * （还带 q / status / cursor 等键），若让它参与推断会把 F 撑成 search 的全部键。
 */
export function checkPublicIds<F extends string>(
  specs: { readonly [K in F]: PublicIdSpec },
  values: Partial<Record<string, string | undefined>>,
): PublicIdCheck<F> {
  const valid: Partial<Record<F, string>> = {}
  const rejected: RejectedPublicId[] = []
  for (const field of Object.keys(specs) as F[]) {
    const raw = values[field]
    if (raw === undefined || raw === '') continue
    const spec = specs[field]
    if (spec.schema.safeParse(raw).success) valid[field] = raw
    else rejected.push({ field, label: spec.label, prefix: spec.prefix, raw })
  }
  return { valid, rejected }
}

/** 非法 ID 的红色提示条 + 清除入口（`role="alert"` 让读屏器立刻播报）。 */
export function RejectedIdNotice({
  items,
  onClear,
}: {
  items: ReadonlyArray<RejectedPublicId>
  onClear: () => void
}) {
  if (items.length === 0) return null
  return (
    <p className="rounded-xl bg-danger-soft px-4 py-2.5 text-danger text-sm" role="alert">
      {items
        .map((item) => `${item.label}「${item.raw}」不是规范的公开 ID（应为 ${item.prefix} 开头）`)
        .join('；')}
      ，已忽略该条件、未发给服务端。
      <button className="font-semibold underline" onClick={onClear} type="button">
        清除
      </button>
    </p>
  )
}
