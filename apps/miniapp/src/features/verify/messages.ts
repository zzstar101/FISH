/**
 * 校园认证页的行内文案：后端错误码 → 文案的映射（#89），加已认证态的隐私说明（#177）。
 *
 * 单独成模块而不是写在页面里：这些是本页唯一可纯函数 / 常量验证的部分，
 * 用例见 `apps/miniapp/tests/verify-messages.test.ts`。
 *
 * 码的取值与状态码映射见 `@fish/contracts/auth/verification` 的
 * `VerificationErrorCodeSchema` 与 `apps/api/src/modules/auth/verification-service.ts`。
 */

/**
 * 发码失败文案。
 *
 * `RATE_LIMITED` 刻意不在表里：后端把「还有几秒 / 今日已用完」写进了 message
 * （`verification-store.ts`），照抄它比一句笼统的「太频繁」有用。
 */
const SEND_MESSAGES: Record<string, string> = {
  EMAIL_ALREADY_BOUND: '该校园邮箱已绑定其他账号',
  VALIDATION_FAILED: '请使用校园教育邮箱',
}

/** 校验失败文案（`RATE_LIMITED` 同上） */
const VERIFY_MESSAGES: Record<string, string> = {
  CODE_INVALID: '验证码不正确，请核对后重新输入',
  CODE_EXPIRED: '验证码已过期，请重新获取',
  CODE_CONSUMED: '验证码已被使用，请重新获取',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请重新获取验证码',
  EMAIL_ALREADY_BOUND: '该校园邮箱已绑定其他账号',
  VALIDATION_FAILED: '请检查邮箱与验证码后重试',
}

/** 这几种失败码意味着手上这枚码已不可用，页面必须解锁「重新发送」 */
const NEEDS_RESEND = new Set(['CODE_EXPIRED', 'CODE_CONSUMED', 'TOO_MANY_ATTEMPTS'])

/**
 * 发码失败的行内文案。
 *
 * 未知码与 `RATE_LIMITED` 一律透传后端 message —— 错误信封里的 message 本来就是
 * 面向用户的（`apps/api/src/modules/auth/verification-store.ts`），编一句更笼统的
 * 反而丢掉「还有几秒」这类可操作信息。
 */
export function sendErrorMessage(code: string, backendMessage: string): string {
  if (code === 'RATE_LIMITED') return backendMessage
  return SEND_MESSAGES[code] ?? backendMessage
}

/** 校验失败的行内文案（口径同 `sendErrorMessage`） */
export function verifyErrorMessage(code: string, backendMessage: string): string {
  if (code === 'RATE_LIMITED') return backendMessage
  return VERIFY_MESSAGES[code] ?? backendMessage
}

/** 该失败码是否要解锁重发：否则用户被自己的 60 秒倒计时锁住，只能干等 */
export function verifyNeedsResend(code: string): boolean {
  return NEEDS_RESEND.has(code)
}

/**
 * 已认证态的隐私说明（`pages/verify` 已认证分支的白卡），拆三段。
 *
 * 拆段不是为复用，而是稿把中间那段加粗（`<b style="color:var(--ink)">`），小程序里只能靠
 * 嵌套 `Text`；页面按这三段拼渲染，用例对拼起来的整句断言。
 *
 * 提成常量只为一件事：这句话**不许暗示可自助解除认证 / 更换邮箱** —— 后端没有解绑端点，
 * 产品与安全语义仍在 #86 冻结中（#86：「UI 在能力未落地前不得暗示可以自行解除认证」）。
 * 设计稿的原文是「如需更换邮箱，需先解除当前认证」，那是**有意不采用**的稿值；
 * 用例是防止后续「照稿对齐」时把它改回去（见 `tests/verify-messages.test.ts`）。
 */
export const VERIFY_PRIVACY_LEAD = '公开页面'
export const VERIFY_PRIVACY_EMPHASIS = '只展示认证徽章'
export const VERIFY_PRIVACY_TAIL = '，不展示邮箱、学号与班级；当前暂不支持自助更换认证邮箱。'

/**
 * 未认证白卡的说明（稿 01 帧 `.vcard` 的描述行）。
 *
 * 稿的原文是「用学校邮箱**验证在校身份**，公开页面只展示徽章」——「在校身份」是**有意不采用**
 * 的稿值，与上面那条隐私句同一类：#86 冻结的语义是 VERIFIED 只证明「能控制一个允许域名下的
 * 教育邮箱」，不得表述成学号 / 校区 / 现实在校身份的核验。留一句「验证在校身份」还会与本页
 * 成功态的「教育邮箱已验证」自相矛盾（同一页前后两种口径）。
 */
export const VERIFY_INTRO_DESC = '用学校邮箱验证教育邮箱归属，公开页面只展示徽章。'

/**
 * 未认证分支底部的居中脚注（稿 01 帧 `.fnote`）。
 *
 * 同样去掉了稿的「仅用于**核验身份**」：本页核验的是教育邮箱控制权，不核验现实在校身份。
 * 「不会公开展示邮箱、学号与班级」照稿保留 —— 那半句是隐私承诺，与核验口径无关；
 * 其中「学号」随 #86 把学号移出产品模型后会一并消失，属 #86 的范围，不在此处改。
 */
export const VERIFY_FOOTNOTE = '认证信息仅用于核验教育邮箱，不会公开展示邮箱、学号与班级。'
