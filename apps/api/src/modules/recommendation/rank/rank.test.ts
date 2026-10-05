import { describe, expect, test } from 'bun:test'
import { RANK_EVAL_RELEVANCE_GRADES } from '@fish/contracts/recommendation/eval'
import { RANK_COOLDOWN_ENGAGEMENT_EVENT_TYPES } from '@fish/contracts/recommendation/rank'

/**
 * 契约级不变式（#323 M6）。
 *
 * 这些断言不测行为，只钉住**两份定义不能漂移**：线上冷却的"用户点过"与离线评估的"相关"
 * 必须是同一个集合（见 `RANK_COOLDOWN_ENGAGEMENT_EVENT_TYPES` 的注释）。放在这里而不是
 * `contracts` 包内：`eval.ts` 已经 import `rank.ts`，反向 import 会成环，所以只能是使用方来钉。
 */
describe('RANK_COOLDOWN_ENGAGEMENT_EVENT_TYPES', () => {
  test('与 `RANK_EVAL_RELEVANCE_GRADES` 里分级 ≥ 1 的集合一致', () => {
    // 两边都先落到 `string[]`：契约里一个是 `Partial<Record<EventType, number>>` 的键、一个是
    // `as const` 元组，直接比会让 `toEqual` 的泛型收窄到元组联合类型上。
    const relevant: readonly string[] = Object.entries(RANK_EVAL_RELEVANCE_GRADES)
      .filter(([, grade]) => grade >= 1)
      .map(([eventType]) => eventType)
      .sort()
    const cooldown: readonly string[] = RANK_COOLDOWN_ENGAGEMENT_EVENT_TYPES

    expect([...cooldown].sort()).toEqual([...relevant])
  })

  test('不含 `QUICK_SKIP`：划过 ≠ 点过，不能用来解除冷却', () => {
    expect([...RANK_COOLDOWN_ENGAGEMENT_EVENT_TYPES]).not.toContain('QUICK_SKIP')
  })
})
