import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useMemo, useState } from 'react'
import brandMark from '@/assets/brand/brand-mark.png'
import brandWordmark from '@/assets/brand/brand-wordmark.png'
import { ICONS } from '@/assets/lib-icons'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { signIn, useAuth } from '@/features/auth/store'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError } from '@/lib/request'
import './index.scss'

/**
 * 登录（设计稿 `小程序1版login.html`）。
 *
 * **契约口径**：学号 + 密码 + httpOnly 会话 cookie（`packages/contracts/src/auth/session.ts`），
 * 不是参考实现里的「手机号 + 验证码」。
 *
 * 与旧版（2改 `设计稿_B1-login.html`）的差异，都按新稿走：
 * - 品牌区 = mark / wordmark 两张图 + 一句 tagline（旧版是渐变方块里一个「鱼」字）；
 * - 表单进一张玻璃卡 `.auth-card`；
 * - 新增「我已阅读并同意」勾选：**未勾选不允许提交**（稿子里默认是勾上的状态）；
 * - 不再有密码可见按钮（新稿没有这只眼睛）。
 *
 * 数据：`POST /auth/login`。成功后 `features/auth/store` 广播登录态、`@/lib/request`
 * 落盘会话 cookie，本页据此跳首页。
 */

/** 学号：12 位数字（契约里 studentNo 的形状） */
const STUDENT_NO_LEN = 12
/** 密码 8~32 位是**契约里的产品规则**（`auth/session.ts` 的 `PasswordSchema`） */
const PASSWORD_MIN = 8
const PASSWORD_MAX = 32

export default function Login() {
  const [studentNo, setStudentNo] = useState('')
  const [password, setPassword] = useState('')
  const [focused, setFocused] = useState<'studentNo' | 'password' | null>(null)
  const [errors, setErrors] = useState<{ studentNo?: string; password?: string }>({})
  const [submitting, setSubmitting] = useState(false)
  /**
   * 协议勾选。稿子里默认是勾上的（`.checkbox` 是品牌色实底 + 白勾），
   * 所以这里默认 `true`，但**允许取消**，且取消后不允许提交 —— 勾选框要真的有意义。
   */
  const [agreed, setAgreed] = useState(true)

  const { status } = useAuth()

  /** 顶部留白：登录页是入口页，没有标题与返回钮，只需按微信胶囊栅格把内容顶下去 */
  const navHeight = useMemo(() => readNavMetrics().totalHeight, [])

  /**
   * 已登录不该停在登录页。
   * 登录成功那一刻也走这条（store 广播 `authed`），所以 `submit()` 里不再自己跳转
   * —— 两处都跳会连发两次 `switchTab`。
   *
   * **必须确认登录页是最上层页面**：从登录页 `navigateTo` 注册页之后，登录页仍在页面栈里
   * （Taro 的 `onHide` 不卸载组件），store 订阅也还在 —— 注册成功的 `emit(authed)`
   * 会触发这条 effect，把刚 `redirectTo` 出来的注册成功页顶掉（实测：落到首页）。
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
      setSubmitting(false)
      void Taro.showToast({ title: '已登录，请手动返回首页', icon: 'none' })
    })
  }, [status])

  const filled = studentNo.trim().length > 0 && password.length > 0
  const canSubmit = filled && agreed && !submitting

  const validate = () => {
    const next: { studentNo?: string; password?: string } = {}
    const no = studentNo.trim()
    if (!no) next.studentNo = '请输入学号后再登录'
    else if (!/^\d+$/.test(no)) next.studentNo = '学号只能是数字'
    else if (no.length !== STUDENT_NO_LEN) next.studentNo = `学号应为 ${STUDENT_NO_LEN} 位数字`
    if (!password) next.password = '请输入密码'
    else if (password.length < PASSWORD_MIN) next.password = `密码至少 ${PASSWORD_MIN} 位`
    else if (password.length > PASSWORD_MAX) next.password = `密码最多 ${PASSWORD_MAX} 位`
    return next
  }

  const toast = (title: string) => void Taro.showToast({ title, icon: 'none' })

  const submit = () => {
    if (submitting) return
    if (!agreed) {
      toast('请先阅读并同意《用户协议》与《隐私政策》')
      return
    }
    const next = validate()
    setErrors(next)
    if (next.studentNo || next.password) return
    setSubmitting(true)
    void (async () => {
      try {
        await signIn({ studentNo: studentNo.trim(), password })
        // 成功后**不**复位 submitting：跳转期间按钮停在 loading，防连点重复登录
        void Taro.showToast({ title: '登录成功', icon: 'success' })
      } catch (error) {
        setSubmitting(false)
        if (isApiError(error) && error.code === 'INVALID_CREDENTIALS') {
          // 401 有两种：`UNAUTHENTICATED`（没登录）与 `INVALID_CREDENTIALS`（账号密码错）。
          // 只有后者是登录表单的行内错误。
          setErrors({ password: '学号或密码不正确' })
          return
        }
        if (isApiError(error)) {
          // 其余错误码（422 的后端文案固定是「请求参数不合法」、5xx 等）不是某一个字段
          // 的问题，挂到「学号」下面只会误导。
          toast(error.message)
          return
        }
        // 非 ApiError = 请求没到后端（域名没配 / 后端没起），这不是字段问题，用 toast
        toast('连不上服务器，请确认后端已启动')
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
            {/* 学号 */}
            <View className="login__field">
              <Text className="login__label">学号</Text>
              <View
                className={`login__input${focused === 'studentNo' ? ' is-focus' : ''}${
                  errors.studentNo ? ' is-error' : ''
                }`}
              >
                <Input
                  className="login__val num"
                  type="number"
                  maxlength={STUDENT_NO_LEN}
                  value={studentNo}
                  disabled={submitting}
                  placeholder="请输入 12 位学号"
                  placeholderClass="login__ph"
                  onInput={(event) => {
                    setStudentNo(event.detail.value)
                    if (errors.studentNo) setErrors((prev) => ({ ...prev, studentNo: undefined }))
                  }}
                  onFocus={() => setFocused('studentNo')}
                  onBlur={() => setFocused(null)}
                />
              </View>
              {errors.studentNo ? <Text className="login__err">{errors.studentNo}</Text> : null}
            </View>

            {/* 密码 */}
            <View className="login__field">
              <Text className="login__label">密码</Text>
              <View
                className={`login__input${focused === 'password' ? ' is-focus' : ''}${
                  errors.password ? ' is-error' : ''
                }`}
              >
                <Input
                  className="login__val login__val--pwd"
                  password
                  value={password}
                  disabled={submitting}
                  placeholder="请输入密码"
                  placeholderClass="login__ph"
                  onInput={(event) => {
                    setPassword(event.detail.value)
                    if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }))
                  }}
                  onFocus={() => setFocused('password')}
                  onBlur={() => setFocused(null)}
                />
              </View>
              {errors.password ? <Text className="login__err">{errors.password}</Text> : null}
            </View>

            {/* 协议勾选：未勾选不允许提交 */}
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

            {/* 主 CTA */}
            <View className={`login__cta${canSubmit ? '' : ' is-off'}`} onClick={submit}>
              {submitting ? <View className="login__spin" /> : null}
              <Text>{submitting ? '登录中…' : '登录'}</Text>
            </View>
          </View>
        </View>

        {/* ---- 去注册 ---- */}
        <View className="login__alt">
          <Text>还没有账号？</Text>
          <Text
            className="login__alt-lk"
            onClick={() => void Taro.navigateTo({ url: '/pages/register/index' })}
          >
            注册
          </Text>
        </View>
      </View>
    </View>
  )
}
