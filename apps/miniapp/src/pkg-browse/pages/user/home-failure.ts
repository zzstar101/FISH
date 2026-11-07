import type { PublicUserFailure } from '@/features/fetchers'
import { segmentErrorSuffix } from './segment-page'

/**
 * 他人主页**整页**失败态的正文（#607）。
 *
 * 分段列表那条路径（#598）已经把 `ApiError` 的 `code` / `status` 写进文案了，整页这条路却
 * 只有一句写死的「网络异常，请重试」：422（端上先发了旧服务端不认的参数，见 #599）、
 * 401（会话失效）、5xx（服务端）在真机上长得一模一样，Owner 验收时看不到 Console，
 * 就没有任何线索区分「版本不匹配」「没登录」「服务端挂了」（#607）。
 *
 * 所以正文与分段**共用同一个后缀函数**（`segmentErrorSuffix`），两条路径只有前半句不同：
 * 整页报「这个人的主页没出来」，分段报「这一段的商品没拉到，其它内容不受影响」。
 * `error === null` = 读取层没有可显示的错误码（例如资料与列表的存在性判断漂移），
 * 这时退到不带码的通用句 —— 不编一个码、也不留一对空括号。
 */
export function homeFailureText(error: PublicUserFailure | null): string {
  if (error === null) return '主页没加载出来，请稍后重试'
  return `主页没加载出来${segmentErrorSuffix(error)}`
}
