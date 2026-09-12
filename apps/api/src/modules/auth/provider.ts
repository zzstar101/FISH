import { StudentNoSchema } from '@fish/contracts/auth/session'
import type { Campus } from '@fish/contracts/auth/user'

/** 校园认证结果。真实 Provider 可以给出权威校区；Mock 只给状态。 */
export type CampusVerification = {
  status: 'VERIFIED' | 'UNVERIFIED'
  campus?: Campus
}

/**
 * Mock 与真实 Provider 之间的唯一边界（#3 验收：「Mock Provider 与真实 Provider 有明确接口边界」）。
 * 接真实教务校验时只替换这个接口的实现，router / service / 契约都不动。
 * `realName` 预留给真实校验（通常需要「学号 + 姓名」），Mock 不使用，#3 也不采集该字段。
 */
export interface CampusVerificationProvider {
  verify(input: { studentNo: string; realName?: string }): Promise<CampusVerification>
}

/**
 * Mock：12 位纯数字**且以 `20` 开头**（20xx 级）才算认证通过。
 *
 * 为什么不直接写「格式合法即通过」：注册校验本身就是严格 12 位数字，那样 `UNVERIFIED`
 * 分支永远不可达，`authStatus` 恒为 `VERIFIED`，徽章看不出差异。以 `20` 开头这个额外条件
 * 让「未认证」有一条真实可达路径（如 `199901000001`），同时不改动学号格式本身。
 *
 * 格式规则直接复用契约里的 `StudentNoSchema`，不在这里另写一份正则。
 */
export function createMockCampusVerificationProvider(): CampusVerificationProvider {
  return {
    async verify({ studentNo }) {
      const trimmed = studentNo.trim()
      const isTwelveDigits = StudentNoSchema.safeParse(trimmed).success
      return { status: isTwelveDigits && trimmed.startsWith('20') ? 'VERIFIED' : 'UNVERIFIED' }
    },
  }
}
