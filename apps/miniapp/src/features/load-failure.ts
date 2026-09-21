/**
 * 取数失败的统一留痕与「演示兜底」开关。
 *
 * 从 `features/fetchers.ts` 抽出来是为了让**不依赖 chat/api 的取数模块**（如
 * `features/wish/load.ts`）也能复用同一套日志口径 —— `fetchers.ts` 太大且会
 * 静态 import 会话域，愿望/匹配的取数没必要跟着拖进来（测试上一并省去 mock 会话域）。
 */
import { isUnauthenticatedError } from '@/lib/request'
import { failureText, isNetworkFailure } from './chat/notif-read'

/**
 * 构建期注入（`config/index.ts` 的 `defineConstants.__ALLOW_MOCK_FALLBACK__`）。
 * 本地演示 / 预览用 `TARO_APP_MOCK=1` 打开，或 H5 预览构建直接注入 `true`。
 */
declare const __ALLOW_MOCK_FALLBACK__: boolean | undefined

/**
 * 未注入 = 关闭（fail closed），见 `fetchers.ts` 文件头「生产口径」。
 *
 * 导出给「不走 fetchers 取数、但需要同一套演示兜底判据」的调用方
 * （当前是底栏的冷启动未读补数：真实构建不得拿 fixture 顶替真实未读数）。
 */
export const MOCK_FALLBACK_ENABLED = __ALLOW_MOCK_FALLBACK__ === true

/**
 * 失败留痕。登录态缺失与网络不可用属于预期情况（是「当前没有后端 / 没登录」，
 * 不是缺陷），因此降级为 debug；其余（含契约解析失败）用 warn ——
 * 那意味着前端与契约已经漂移，不该被静默吞掉。
 *
 * 日志里必须写明**这次有没有按演示口径兜底**：生产口径下没兜，看日志的人才知道
 * 用户看到的是错误态，而不是以为「又是演示数据」。
 *
 * `fellBack` 是**这次操作实际有没有按演示口径兜底**：调用方知道就传（逐条已读只在
 * 整批后端不可达时才兜底；个人中心只在 `MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`
 * 时才兜），不知道就沿用构建开关的口径。页面若**刻意不回退**（如他人主页、愿望/匹配，
 * 见 `loadPublicUserHome`、`loadWishes`）必须显式传 `false`，否则日志会声称一件没发生的事。
 */
export function reportFailure(
  what: string,
  error: unknown,
  fellBack: boolean = MOCK_FALLBACK_ENABLED,
): void {
  const expected = isUnauthenticatedError(error) || isNetworkFailure(error)
  const detail = failureText(error)
  const tail = fellBack
    ? '，已按演示口径处理（开发 / 预览构建）'
    : MOCK_FALLBACK_ENABLED
      ? '，未按演示口径处理'
      : '，未回退 mock（生产口径）'
  if (expected) {
    console.debug(`[miniapp] ${what}：真实接口不可用${tail}（${detail}）`)
    return
  }
  console.warn(`[miniapp] ${what}：真实接口失败${tail}`, error)
}
