import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import { signIn, useAuth } from '@/features/auth/store'
import { ApiError } from '@/lib/request'
import './index.scss'

/**
 * B1 登录（设计稿 `设计稿_B1-login.html`）。
 *
 * **契约口径**：本仓 #3 冻结的是「学号 + 密码 + httpOnly cookie」，
 * 而不是参考实现里的「手机号 + 验证码」——按契约走。
 *
 * 状态覆盖（对应设计稿四帧）：默认 / 校验失败（错误小字贴各自输入框下）/
 * 提交中（按钮 loading + 全表禁用，防重复提交）/ 边界（密码明文 + 聚焦环 + 未填完则禁用）。
 *
 * 数据：`POST /auth/login`，成功后由 `features/auth/store` 广播登录态、
 * `@/lib/request` 落盘会话 cookie，本页据此跳到首页。
 */

/** 学号：12 位数字（契约里 studentNo 的形状） */
const STUDENT_NO_LEN = 12
/** 密码 8~32 位是**契约里的产品规则**（`auth/session.ts` 的 `PasswordSchema`），不是随手定的 */
const PASSWORD_MIN = 8
const PASSWORD_MAX = 32

export default function Login() {
  const [studentNo, setStudentNo] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [focused, setFocused] = useState<'studentNo' | 'password' | null>(null)
  const [errors, setErrors] = useState<{ studentNo?: string; password?: string }>({})
  const [submitting, setSubmitting] = useState(false)

  const { status } = useAuth()

  /**
   * 已登录不该停在登录页。
   * 登录成功那一刻也走这条（store 广播 `authed`），所以 `submit()` 里不再自己跳转
   * —— 两处都跳会连发两次 `switchTab`。
   */
  useEffect(() => {
    if (status !== 'authed') return
    void Taro.switchTab({ url: '/pages/home/index' }).catch(() => {
      // 跳转失败必须给出口：否则按钮会永远停在「登录中…」的禁用态上
      setSubmitting(false)
      void Taro.showToast({ title: '已登录，请手动返回首页', icon: 'none' })
    })
  }, [status])

  const filled = studentNo.trim().length > 0 && password.length > 0
  const canSubmit = filled && !submitting

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

  const submit = () => {
    if (submitting) return
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
        if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') {
          // 401 有两种：`UNAUTHENTICATED`（没登录）与 `INVALID_CREDENTIALS`（账号密码错）。
          // 只有后者是登录表单的行内错误。
          setErrors({ password: '学号或密码不正确' })
          return
        }
        if (error instanceof ApiError) {
          // 其余错误码（422 VALIDATION_FAILED 的后端文案固定是「请求参数不合法」、
          // 5xx 等）都不是某一个字段的问题，挂到「学号」下面只会误导。
          void Taro.showToast({ title: error.message, icon: 'none' })
          return
        }
        // 非 ApiError = 请求没到后端（域名没配 / 后端没起），这不是字段问题，用 toast
        void Taro.showToast({ title: '连不上服务器，请确认后端已启动', icon: 'none' })
      }
    })()
  }

  return (
    <View className={`login${submitting ? ' is-off' : ''}`}>
      <View className="login__brandhead">
        {/* 设计稿：品牌渐变方块里是白色「鱼」字，不是 logo 图 */}
        <View className="login__logo">
          <Text className="login__logo-tx">鱼</Text>
        </View>
        <Text className="login__wordmark">鱼小应</Text>
        <Text className="login__slogan">同校之间，把闲置交到需要的人手里</Text>
      </View>

      <View className="login__content">
        {/* ---- 学号 ---- */}
        <View className="login__field">
          <View className="login__flabel">
            <Text>学号</Text>
          </View>
          <View
            className={`login__input${focused === 'studentNo' ? ' is-focus' : ''}${
              errors.studentNo ? ' is-error' : ''
            }${submitting ? ' is-off' : ''}`}
          >
            <Image className="login__input-ic" src={ICONS.user} mode="aspectFit" />
            <Input
              className="login__val num"
              type="number"
              maxlength={STUDENT_NO_LEN}
              value={studentNo}
              disabled={submitting}
              placeholder="学号"
              placeholderClass="login__ph"
              onInput={(event) => {
                setStudentNo(event.detail.value)
                if (errors.studentNo) setErrors((prev) => ({ ...prev, studentNo: undefined }))
              }}
              onFocus={() => setFocused('studentNo')}
              onBlur={() => setFocused(null)}
            />
          </View>
          {errors.studentNo ? (
            <Text className="login__ferr">{errors.studentNo}</Text>
          ) : (
            <Text className="login__fhelp">{`${STUDENT_NO_LEN} 位学号，例 2023051178`}</Text>
          )}
        </View>

        {/* ---- 密码 ---- */}
        <View className="login__field">
          <View className="login__flabel">
            <Text>密码</Text>
          </View>
          <View
            className={`login__input${focused === 'password' ? ' is-focus' : ''}${
              errors.password ? ' is-error' : ''
            }${submitting ? ' is-off' : ''}`}
          >
            <Image className="login__input-ic" src={ICONS.lock} mode="aspectFit" />
            <Input
              className={`login__val${showPwd ? '' : ' login__val--pwd'}`}
              password={!showPwd}
              value={password}
              disabled={submitting}
              placeholder="密码"
              placeholderClass="login__ph"
              onInput={(event) => {
                setPassword(event.detail.value)
                if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }))
              }}
              onFocus={() => setFocused('password')}
              onBlur={() => setFocused(null)}
            />
            {/* 密码可见性：设计稿有这只眼睛，用「浏览」图标（库里没有独立的眼睛） */}
            <View
              className={`login__eye${showPwd ? ' is-on' : ''}`}
              onClick={() => setShowPwd((prev) => !prev)}
            >
              <Image
                className="login__eye-ic"
                src={showPwd ? ICONS.browse : ICONS.browseMuted}
                mode="aspectFit"
              />
            </View>
          </View>
          {errors.password ? <Text className="login__ferr">{errors.password}</Text> : null}
        </View>

        <View className={`login__submit${canSubmit ? '' : ' is-off'}`} onClick={submit}>
          {submitting ? <View className="login__spin" /> : null}
          <Text>{submitting ? '登录中…' : '登录'}</Text>
        </View>

        <View className="login__alt">
          <Text>还没有账号？</Text>
          <Text
            className="login__alt-link"
            onClick={() => void Taro.navigateTo({ url: '/pages/register/index' })}
          >
            去注册
          </Text>
        </View>

        <View className="login__legal">
          <Text>登录即表示同意</Text>
          <Text className="login__legal-link">《用户协议》</Text>
          <Text>与</Text>
          <Text className="login__legal-link">《隐私政策》</Text>
        </View>
      </View>
    </View>
  )
}
