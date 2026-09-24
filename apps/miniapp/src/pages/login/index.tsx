import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import brandMark from '@/assets/brand/brand-mark.png'
import brandWordmark from '@/assets/brand/brand-wordmark.png'
import { ICONS } from '@/assets/lib-icons'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { wechatLoginFailureMessage } from '@/features/auth/login-messages'
import { signInWithWechat, useAuth } from '@/features/auth/store'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError } from '@/lib/request'
import './index.scss'

/**
 * 登录（设计稿 `小程序1版login.html`，按 Owner 决定改为**仅微信登录**）。
 *
 * **契约口径**：只有一条路径 —— 微信 `code` → 会话
 * （`packages/contracts/src/auth/wechat.ts`，#86 A 节的主身份）。
 * 学号 + 密码入口已从小程序端移除（#86 E 线提前到端上执行）；
 * 后端 `POST /auth/login` / `/auth/register` **仍然保留**，因为 web 端还在用，
 * 等 web 也能用微信授权登录后再一起下线。
 *
 * 与旧版的差异，都按新稿走：
 * - 品牌区 = mark / wordmark 两张图 + 一句 tagline；
 * - 表单进一张玻璃卡 `.login__card`；
 * - 「我已阅读并同意」勾选保留：**未勾选不允许登录**（协议同意仍需要一个落点）；
 * - 学号 / 密码字段、`.login__or` 分隔行、去注册入口整段删除。
 *
 * 数据：`POST /auth/wechat/session`。成功后 `features/auth/store` 广播登录态、
 * `@/lib/request` 落盘会话 cookie，本页据此跳首页。
 */

export default function Login() {
  /** 微信登录的忙碌位：防连点（成功跳转期间保持 loading），同时驱动按钮的 loading 态 */
  const [wechatBusy, setWechatBusy] = useState(false)
  /**
   * 防连点的**同步**闸门（#198 对抗审查 P3-2）。
   *
   * `wechatBusy` 是 state：`setState` 要等下一次渲染才可见，同一帧里的第二次点击读到的仍是
   * 旧值 `false`，两次点击都会把整个登录流程跑完（两次 `Taro.login()` + 两次换会话）。
   * ref 是同步写入的，所以**判它**，state 只负责 UI。
   */
  const wechatBusyRef = useRef(false)
  /** busy 的唯一写入口：ref 与 state 必须一起动，否则闸门和按钮会分家。 */
  const setBusy = useCallback((busy: boolean) => {
    wechatBusyRef.current = busy
    setWechatBusy(busy)
  }, [])
  /**
   * 协议勾选。新稿默认是勾上的（`.checkbox` 是品牌色实底 + 白勾），
   * 所以这里默认 `true`，但**允许取消**，且取消后不允许登录 —— 勾选框要真的有意义。
   */
  const [agreed, setAgreed] = useState(true)

  const { status } = useAuth()

  /** 顶部留白：登录页是入口页，没有标题与返回钮，只需按微信胶囊栅格把内容顶下去 */
  const navHeight = useMemo(() => readNavMetrics().totalHeight, [])

  /**
   * 已登录不该停在登录页。
   * 登录成功那一刻也走这条（store 广播 `authed`），所以 `wechatLogin()` 里不自己跳转
   * —— 两处都跳会连发两次 `switchTab`。
   *
   * **必须确认登录页是最上层页面**：登录页 `navigateTo` 出去后仍在页面栈里
   * （Taro 的 `onHide` 不卸载组件），store 订阅也还在 —— 别处成功的 `emit(authed)`
   * 会触发这条 effect，把刚 `redirectTo` 出来的页面顶掉（实测：落到首页）。
   */
  useEffect(() => {
    // 演示构建（`TARO_APP_MOCK=1`）里不弹走：那套构建的目的就是每一页都能直接打开，
    // 而演示账号初值即已登录，弹走等于登录页永远看不到（见 `features/auth/demo.ts`）
    if (DEMO_AUTH_ENABLED) return
    if (status !== 'authed') return
    const pages = Taro.getCurrentPages()
    const top = (pages[pages.length - 1] as { route?: string } | undefined)?.route ?? ''
    if (top !== 'pages/login/index') return
    void Taro.switchTab({ url: '/pages/home/index' }).catch(() => {
      // 跳转失败必须给出口：否则按钮会永远停在「登录中…」的禁用态上
      setBusy(false)
      void Taro.showToast({ title: '已登录，请手动返回首页', icon: 'none' })
    })
  }, [status, setBusy])

  const canWechat = agreed && !wechatBusy

  const toast = (title: string) => void Taro.showToast({ title, icon: 'none' })

  /**
   * 微信一键登录（#86 A 节）。
   *
   * `Taro.login()` 拿到的是**一次性** code（微信侧 5 分钟有效、用后即废），
   * 只上报给后端换 FISH 会话；openid / session_key 既不经过客户端存储，也不在响应里。
   * 首次登录后端自动建号，同一微信用户重复登录落到同一账号（契约见 `auth/wechat.ts`）。
   * 微信这个接口是**静默**的：没有授权弹窗，用户点一下即登录 —— 这是微信的产品设计。
   */
  const wechatLogin = () => {
    // 判 ref 而不是 state：见 `wechatBusyRef` 的注释（同一帧的第二次点击）
    if (wechatBusyRef.current) return
    if (!agreed) {
      toast('请先阅读并同意《用户协议》与《隐私政策》')
      return
    }
    setBusy(true)
    void (async () => {
      try {
        const { code } = await Taro.login()
        if (!code) throw new Error('wx.login 未返回 code')
        await signInWithWechat(code)
        // 成功后**不**复位 busy：跳转期间按钮停在 loading，防连点重复登录
        void Taro.showToast({ title: '登录成功', icon: 'success' })
      } catch (error) {
        setBusy(false)
        // 错误码 → 用户提示的映射在 `features/auth/login-messages.ts`（Taro-free，有单测）。
        // 这里只负责把 `ApiError` 收窄成纯数据。
        toast(
          wechatLoginFailureMessage(
            isApiError(error) ? { code: error.code, message: error.message } : null,
          ),
        )
      }
    })()
  }

  return (
    <View className="login">
      <View className="login__bg" />

      <View className="login__body" style={{ paddingTop: `${navHeight}px` }}>
        {/* ---- 品牌区（稿：mark / wordmark 两张图 + tagline） ---- */}
        <View className="login__brand">
          <Image className="login__mark" src={brandMark} mode="aspectFit" />
          <Image className="login__wordmark" src={brandWordmark} mode="aspectFit" />
          <Text className="login__tagline">同校面交 · 让闲置在校园里流动起来</Text>
        </View>

        {/* ---- 表单卡 ---- */}
        <View className="login__card">
          <View className="login__form">
            {/* 协议勾选：未勾选不允许登录 */}
            <View
              className={`login__agree${agreed ? ' is-on' : ''}`}
              onClick={() => setAgreed((prev) => !prev)}
            >
              <View className="login__checkbox">
                <Image className="login__checkbox-ic" src={ICONS.checkWhite} mode="aspectFit" />
              </View>
              <Text className="login__agree-tx">
                我已阅读并同意
                {/*
                  链接必须吃掉冒泡：父级是「勾选框」的 onClick，不拦截的话点协议会顺手
                  把默认勾选翻成未勾（然后点登录只得到「请先阅读并同意」的提示）。
                */}
                <Text
                  className="login__lk"
                  onClick={(event) => {
                    event.stopPropagation()
                    toast('用户协议待接入')
                  }}
                >
                  《用户协议》
                </Text>
                和
                <Text
                  className="login__lk"
                  onClick={(event) => {
                    event.stopPropagation()
                    toast('隐私政策待接入')
                  }}
                >
                  《隐私政策》
                </Text>
              </Text>
            </View>

            {/* 唯一 CTA：微信一键登录 */}
            <View
              className={`login__cta login__cta--wechat${canWechat ? '' : ' is-off'}`}
              onClick={wechatLogin}
            >
              {wechatBusy ? <View className="login__spin" /> : null}
              <Text>{wechatBusy ? '微信登录中…' : '微信一键登录'}</Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  )
}
