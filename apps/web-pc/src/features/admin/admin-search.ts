/**
 * Admin 路由 URL 查询参数的解析助手（#467）。
 *
 * 验收要求「查询条件写入 URL，刷新/返回可恢复，条件变化重置游标」：
 * - 列表路由的 `validateSearch` 用这里的函数把 URL 参数收敛成强类型 search；
 *   非法值一律丢弃回默认，而不是把脏参数继续写回 URL。
 * - 「条件变化重置游标」由页面在 `navigate({ search })` 时用 `withoutCursor` 完成：
 *   cursor 只在「同一组条件下翻页」时保留。
 */

/**
 * URL 参数 → 契约枚举；非法值丢弃回 `undefined`（= 不筛选）。
 *
 * `schema` 用结构化签名而不是直接 import zod——web-pc 不依赖 zod（契约包才依赖），
 * 传入的实参是 `@fish/contracts` 的 zod schema，`safeParse` 形状即所需要的一切。
 */
export function optionalSearch<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T | undefined {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** URL 关键词参数：trim 后非空且不超长才采纳（与服务端 `max(50)` 口径一致）。 */
export function trimmedSearch(value: unknown, maxLength = 50): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined
  return trimmed
}

/** 游标：URL 里出现的任何非空串原样回传（服务端解码失败会 422，页面按错误态处理）。 */
export function cursorSearch(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * URL 日期参数（`<input type="date">` 的 `YYYY-MM-DD`）→ 原样回传，形状不对就丢弃。
 *
 * 与 `dayRangeSearch` 的分工：这个只把 URL 参数收敛成「看起来是日期」，页面拿到后原样写回
 * 输入框、提交时才经 `dayRangeSearch` 换算成服务端时间区间（那里才做真实日期校验）。
 * #465 审查发现：各列表页的 `parse*Search` 里内联抄了同一段正则，抽到这里，全仓只此一份。
 */
export function dayParam(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

/**
 * 日期输入（`<input type="date">` 的 `YYYY-MM-DD`）→ 服务端时间段。
 *
 * 契约口径是**左闭右开**（`>= createdFrom` 且 `< createdTo`）：`createdTo` 直接传用户选的
 * 当天会丢掉恰好落在 23:59:59.x 的记录，所以这里把「至某天」换算成**次日零点**（排他）。
 * 时刻按浏览器本地时区解释，与用户看日历的直觉一致；非法/缺省输入整体省略。
 */
export function dayRangeSearch(
  fromDay: unknown,
  toDay: unknown,
): { createdFrom?: string; createdTo?: string } {
  const from = dayStartIso(fromDay)
  // 「至 X 日」= 含 X 日全天 → 排他上界取 X+1 日零点。
  const to = toDayStartNextIso(toDay)
  return {
    ...(from !== undefined ? { createdFrom: from } : {}),
    ...(to !== undefined ? { createdTo: to } : {}),
  }
}

function dayStartIso(value: unknown): string | undefined {
  const day = parseDay(value)
  if (day === undefined) return undefined
  return new Date(day.year, day.month - 1, day.day).toISOString()
}

function toDayStartNextIso(value: unknown): string | undefined {
  const day = parseDay(value)
  if (day === undefined) return undefined
  return new Date(day.year, day.month - 1, day.day + 1).toISOString()
}

function parseDay(value: unknown): { year: number; month: number; day: number } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined
  }
  return { year, month, day }
}

/** 条件变化时的 search 更新：整份替换但剥掉 cursor（验收：条件变化重置游标）。 */
export function withoutCursor<T extends object>(
  search: T & { cursor?: string },
): Omit<T, 'cursor'> {
  const { cursor: _cursor, ...rest } = search
  return rest
}
