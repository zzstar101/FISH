/**
 * 受限页守卫：**只在确定未登录（`anonymous`）时**跳登录页。
 *
 * 三个刻意的选择：
 * 1. 不处理 `unknown`（冷启动 `GET /me` 未返回）。把「还不知道」当成「没登录」，
 *    已登录用户冷启动会先闪一下登录页。
 * 2. Tab 页（消息 / 出物）用 `navigateTo` 而不是 `redirectTo`：`redirectTo` 会**关掉**
 *    当前页，把 Tab 页从栈里换掉之后底栏结构就不完整了；`navigateTo` 只是把登录页
 *    压在栈上，登录成功后 `switchTab` 回首页，Tab 结构原样保留。
 *    （注意：官方对 `redirectTo` 的限制是**目标**页不能是 tabBar 页，不是不能从 Tab 页跳走。）
 * 3. 跳转失败（页面栈满、平台限制等）时退到 `reLaunch`：守卫宁可把页面栈重开一遍，
 *    也不能静默失败 —— 那会让用户停在未登录的页面上，而 effect 不会再触发。
 */
import Taro from '@tarojs/taro'
import { useEffect } from 'react'
import { type AuthStatus, bootstrapAuth, useAuth } from './store'

const LOGIN_PAGE = '/pages/login/index'

/** 页面在 TabBar 上时必须用 `navigateTo`（见文件头第 2 条） */
type GuardOptions = {
  /** 当前页是 Tab 页 */
  tab?: boolean
}

/**
 * 挂在受限页顶部即可；返回当前登录态，页面可以据此决定要不要发请求。
 *
 * 「我的」页不用它：那是登录入口本身，未登录时该显示引导卡而不是被踢走。
 */
export function useAuthGuard(options: GuardOptions = {}): AuthStatus {
  const { status } = useAuth()

  /**
   * 兜底：万一日志恢复那一步没被触发（`app.ts` 的 `useLaunch` 在个别平台上时序不同），
   * 受限页自己叫一次 —— `bootstrapAuth()` 幂等，重复调用不会重复请求。
   * 不做这一步的话，状态会永远停在 `unknown`：页面既不跳登录、也永远显示恢复占位。
   */
  useEffect(() => {
    if (status === 'unknown') void bootstrapAuth()
  }, [status])

  useEffect(() => {
    if (status !== 'anonymous') return
    const navigate = options.tab ? Taro.navigateTo : Taro.redirectTo
    void navigate({ url: LOGIN_PAGE }).catch(() => {
      void Taro.reLaunch({ url: LOGIN_PAGE })
    })
  }, [status, options.tab])

  return status
}
