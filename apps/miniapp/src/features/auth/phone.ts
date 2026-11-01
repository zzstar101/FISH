/**
 * 手机号绑定（#204）的端上逻辑：授权回调分类 / 失败文案 / 会话绑定，**不 import Taro**
 * （所以能在 bun 里直接测，同 `./login-messages` 与 `features/profile/save.ts` 的拆分理由）。
 *
 * 为什么需要这三段独立成模块：它们是「用户看到什么、写进哪个账号」的唯一决定处，
 * 而设置页的 JSX 与 `catch` 拉不起 Taro runtime，测不了。
 *
 * 契约边界（`packages/contracts/src/auth/phone.ts`）：端上只交 `getPhoneNumber` 给的一次性
 * `code`；`encryptedData` / `iv` / 明文号码**既不上报也不读取**。
 */

/** `onGetPhoneNumber` 的 `detail` 收窄：Taro 类型按「成功」声明（含 required 的加密字段），
 *  实际拒绝授权时只有 `errMsg`，所以这里只声明真正会读的两个字段。 */
export type PhoneAuthDetail = {
  /** 回调状态：成功形如 `getPhoneNumber:ok`，拒绝形如 `getPhoneNumber:fail user deny` */
  errMsg?: string
  /** 一次性动态令牌（成功才有） */
  code?: string
}

/**
 * 一次授权的归类结果。
 *
 * `denied` / `privacy-denied` / `incomplete` 三种都**不是**错误：用户没给或没走完授权，
 * 轻提示一句即可（后端一次都没被调用，谈不上「绑定失败」）。
 */
export type PhoneAuthResult =
  | { kind: 'code'; code: string }
  /** 用户在弹窗里点了拒绝 / 取消 */
  | { kind: 'denied' }
  /** 用户没同意《用户隐私保护指引》，微信在隐私接口处直接拦下 */
  | { kind: 'privacy-denied' }
  /** 没有 code 也不像拒绝（低版本基础库、开发者工具未登录等） */
  | { kind: 'incomplete' }

/**
 * 把 `onGetPhoneNumber` 的 `detail` 归类。
 *
 * 只有 `code` 存在才允许发请求：`encryptedData` / `iv` 是老解密链路，本项目不用
 * （服务端拿 code 调微信 `getuserphonenumber`），读它们只会多一份明文风险面。
 */
export function readPhoneAuthResult(detail: PhoneAuthDetail | null | undefined): PhoneAuthResult {
  const code = typeof detail?.code === 'string' ? detail.code.trim() : ''
  if (code.length > 0) return { kind: 'code', code }
  // 拒绝 / 隐私未授权都只看 `errMsg`：微信没有给结构化原因码，文案是唯一信号
  const errMsg = (detail?.errMsg ?? '').toLowerCase()
  if (errMsg.includes('privacy')) return { kind: 'privacy-denied' }
  if (errMsg.includes('deny') || errMsg.includes('cancel')) return { kind: 'denied' }
  return { kind: 'incomplete' }
}

/** 没拿到 code 时的轻提示（`readPhoneAuthResult` 的三种非 code 分支）。 */
export function phoneAuthHint(result: Exclude<PhoneAuthResult, { kind: 'code' }>): string {
  if (result.kind === 'denied') return '已取消手机号授权'
  if (result.kind === 'privacy-denied') return '需同意隐私保护指引后才能绑定手机号'
  return '手机号授权未完成，请重试'
}

/** `POST /auth/phone/bind` 的契约错误（`ApiError` 里这里用得上的两个字段）。 */
export interface PhoneBindFailure {
  code: string
  message: string
}

/**
 * 绑定失败 → 用户可见文案。
 *
 * 三档失败面（后端 #204 的冻结口径）在端上是**三种不同的引导**，不能混成一句
 * 「绑定失败」：授权失效要重点一次授权按钮，号码不支持要换号，上游故障只要稍后再试。
 *
 * @param failure `isApiError(error)` 为真时传 `{ code, message }`，否则传 `null`
 *   （请求没到后端：断网 / 超时）。
 */
export function phoneBindFailureMessage(failure: PhoneBindFailure | null): string {
  if (failure === null) return '网络异常，请稍后重试'
  // 422：code 无效 / 过期 / 已用过。重点一次授权即可拿到新 code，与账号无关。
  if (failure.code === 'PHONE_CODE_INVALID') return '手机号授权已失效，请重新授权'
  // 422：号码不是 11 位大陆号。用户可纠正（换号），重试同一个号没有意义。
  if (failure.code === 'PHONE_NUMBER_UNSUPPORTED') {
    return '暂不支持该手机号，请使用中国大陆手机号'
  }
  // 502：微信上游不可达 / 超时。会话不受影响，等一会儿再试。
  if (failure.code === 'PHONE_UPSTREAM_FAILED') return '手机号服务暂不可用，请稍后重试'
  // 409：这个号已经绑在**别的**账号上。换号，或先解绑原账号（本产品暂无解绑通路）。
  if (failure.code === 'PHONE_ALREADY_BOUND') return '该手机号已被其他账号绑定'
  // 503：后端没开手机号绑定（`WECHAT_TRANSPORT=off`）。
  if (failure.code === 'WECHAT_DISABLED') return '手机号绑定暂未开通'
  // 401：会话已失效。`lib/request` 已就地清会话、守卫会把页面踢回登录页，这里只补一句。
  if (failure.code === 'UNAUTHENTICATED') return '登录已失效，请重新登录'
  // 其余契约错误（校验类等）透传后端文案，不吞成通用句子
  return failure.message.length > 0 ? failure.message : '绑定失败，请稍后重试'
}

/**
 * 会话标识：`ownerId` + **代次**（同 `features/profile/save.ts` 的 `SessionKey`）。
 *
 * 只看 `ownerId` 不够：退出再登回**同一个**账号时 `ownerId` 没变，但旧请求用的凭据已经不是现在这份。
 * `ownerId` 为 `null` 表示「现在没有登录账号」（store 读不到人），任何任务都不再属于当前会话。
 */
export type PhoneBindSession = {
  ownerId: string | null
  /** `lib/session` 的会话代次（`clearSession()` 自增） */
  epoch: number
}

/** 一次绑定任务绑定的会话：发起时一定有账号，所以 `ownerId` 非空 */
export type PhoneBindTicket = PhoneBindSession & { ownerId: string }

/** 这个绑定任务还属于当前会话吗 —— 发请求前与响应回来后各问一次。 */
export function isPhoneBindCurrent(ticket: PhoneBindTicket, session: PhoneBindSession): boolean {
  return ticket.ownerId === session.ownerId && ticket.epoch === session.epoch
}

export type PhoneBindOutcome =
  /** 绑定成功；`ownerId` 是**发起任务那个**账号，页面据此广播 */
  | { kind: 'bound'; ownerId: string; maskedPhone: string }
  /** 会话已变 / 已退出 / 页面已卸载：不写 store、不弹提示 */
  | { kind: 'aborted' }
  /** 请求抛错，交页面翻译成文案（`phoneBindFailureMessage`） */
  | { kind: 'failed'; error: unknown }

export type PhoneBindDeps = {
  /** `POST /auth/phone/bind`，只交一次性 code */
  bindPhone(code: string): Promise<{ maskedPhone: string }>
  /** 读**当前**会话（不是开任务时那个） */
  session(): PhoneBindSession
}

/**
 * 跑一次绑定。
 *
 * 单次请求，但「换号」仍然必须防：请求飞行途中用户可能退出并登进另一个账号，
 * 那时迟到的 200 属于**上一个**账号 —— 写进 store 会让新账号长期显示别人的掩码号
 * （store 是全局单例，`GET /me` 不会自我纠正）。所以响应回来后先重新问一次会话，
 * 返回 `aborted` 时页面必须什么都不做。
 */
export async function runPhoneBind(
  input: { ticket: PhoneBindTicket; code: string },
  deps: PhoneBindDeps,
): Promise<PhoneBindOutcome> {
  const alive = () => isPhoneBindCurrent(input.ticket, deps.session())
  // 换号后绝不发这个请求：它带的是新账号的凭据，却承诺的是旧账号的授权结果
  if (!alive()) return { kind: 'aborted' }

  try {
    const bound = await deps.bindPhone(input.code)
    if (!alive()) return { kind: 'aborted' }
    return { kind: 'bound', ownerId: input.ticket.ownerId, maskedPhone: bound.maskedPhone }
  } catch (error) {
    // 迟到的失败也不该给新账号弹旧账号的错误
    if (!alive()) return { kind: 'aborted' }
    return { kind: 'failed', error }
  }
}
