import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo } from 'react'
import AuthRequired from '@/components/auth-required'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 注册成功提示页（设计稿 `1改/校园认证页面（包括注册跳转页面）.html` 00 帧）。
 *
 * 为什么是独立页面而不是注册页的页内成功态：契约是**注册即登录**，成功后用户已经处于
 * 已登录状态，「注册完成 + 去认证 / 先逛逛」是一个有自己出口的结果页；放在注册页里
 * 会让「返回」能回到已经提交过的表单。
 *
 * **认证状态用真实登录态**（契约的 `Me.authStatus`）渲染：注册出来的账号是 UNVERIFIED，
 * 但如果用户已经认证过（例如从历史栈回到这一页），文案与徽章要跟着变，不能写死「未认证」。
 * 已认证分支是**防御性**的，设计稿没有这一帧，保留。
 */

export default function RegisterSuccess() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const navHeight = useMemo(() => readNavMetrics().totalHeight, [])

  /** 未登录 / 登录态未就绪：守卫在跳转，这里同时拦住渲染 */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  /**
   * 认证状态取**真实登录态**。
   *
   * 注册出来的账号按契约恒为 UNVERIFIED，所以正常路径下走的是未认证分支；
   * 已认证分支是**防御性**的：等校园认证页（`pages/verify`，BLOCKED #68）落地并开始往
   * store 写状态之后，从历史栈回到这一页就会命中它 —— 那时文案不能再说「未认证」。
   */
  const verified = user?.authStatus === 'VERIFIED'

  const toast = (title: string) => void Taro.showToast({ title, icon: 'none' })
  const goVerify = () =>
    void Taro.navigateTo({ url: '/pages/verify/index' }).catch(() => toast('打开失败，请重试'))
  const goBrowse = () =>
    void Taro.switchTab({ url: '/pages/home/index' }).catch(() => toast('打开失败，请重试'))

  return (
    <View className="rs">
      <View className="rs__bg" />

      <View className="rs__body" style={{ paddingTop: `${navHeight}px` }}>
        <View className="rs__done">
          <View className="rs__check">
            <View className="rs__check-ic" />
          </View>

          <Text className="rs__title">注册成功</Text>
          <Text className="rs__desc">
            {verified ? (
              '账号已创建并自动登录。当前状态为已认证'
            ) : (
              <>
                账号已创建并自动登录。当前状态为
                <Text className="rs__b">未认证</Text>
              </>
            )}
          </Text>

          <Text className={`rs__badge${verified ? ' is-ok' : ''}`}>
            {verified ? '已认证 · 校园身份已核验' : '未认证 · 待完成校园认证'}
          </Text>

          <View className="rs__actions">
            <View className="rs__cta" onClick={goVerify}>
              <Text>去校园认证</Text>
            </View>
            <View className="rs__cta rs__cta--outline" onClick={goBrowse}>
              <Text>先随便逛逛</Text>
            </View>
          </View>

          <Text className="rs__note">也可以稍后在「我的 → 校园认证」完成</Text>
        </View>
      </View>
    </View>
  )
}
