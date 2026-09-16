import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
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
 * 数据：`POST /auth/login`（后端已就绪，PR #18），本页只做前端的字段校验与交互，
 * 提交动作停在「待接入」，不假装已登录。
 */

/** 学号：12 位数字（契约里 studentNo 的形状） */
const STUDENT_NO_LEN = 12

export default function Login() {
  const [studentNo, setStudentNo] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [focused, setFocused] = useState<'studentNo' | 'password' | null>(null)
  const [errors, setErrors] = useState<{ studentNo?: string; password?: string }>({})
  const [submitting, setSubmitting] = useState(false)

  const filled = studentNo.trim().length > 0 && password.length > 0
  const canSubmit = filled && !submitting

  const validate = () => {
    const next: { studentNo?: string; password?: string } = {}
    const no = studentNo.trim()
    if (!no) next.studentNo = '请输入学号后再登录'
    else if (!/^\d+$/.test(no)) next.studentNo = '学号只能是数字'
    else if (no.length !== STUDENT_NO_LEN) next.studentNo = `学号应为 ${STUDENT_NO_LEN} 位数字`
    if (!password) next.password = '请输入密码'
    else if (password.length < 6) next.password = '密码至少 6 位'
    return next
  }

  const submit = () => {
    if (submitting) return
    const next = validate()
    setErrors(next)
    if (next.studentNo || next.password) return
    setSubmitting(true)
    // 真实实现：POST /auth/login（成功后会种 httpOnly cookie）
    setTimeout(() => {
      setSubmitting(false)
      void Taro.showToast({ title: '登录接口待接入', icon: 'none' })
    }, 800)
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
