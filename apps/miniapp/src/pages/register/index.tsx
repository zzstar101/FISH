import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import type { Campus } from '@/mock/types'
import './index.scss'

/**
 * B2 注册（设计稿 `设计稿_B2-register.html`）。
 *
 * 与 B1 同结构，多出「昵称 / 校区单选 / 二次密码」，且注册成功后账号是
 * **UNVERIFIED** —— 成功态要引导去校园认证（B3），这是设计稿第 03 帧的重点。
 *
 * 数据：`POST /auth/register`（后端已就绪，PR #18）。提交停在「待接入」，
 * 但成功态是真实可达的（校验通过即展示），因为它是引导用户去认证的关键一步。
 */

const STUDENT_NO_LEN = 12
/** 校区值域对齐 `auth/user.ts` 的 Campus */
const CAMPUSES: Campus[] = ['肇庆', '广州']

type FieldKey = 'nickname' | 'studentNo' | 'password' | 'password2'

export default function Register() {
  const [nickname, setNickname] = useState('')
  const [studentNo, setStudentNo] = useState('')
  const [campus, setCampus] = useState<Campus>('肇庆')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [focused, setFocused] = useState<FieldKey | null>(null)
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  /** 注册成功态（设计稿第 03 帧） */
  const [done, setDone] = useState(false)

  const pwd2Ok = password2.length > 0 && password2 === password
  const filled =
    nickname.trim().length > 0 &&
    studentNo.trim().length > 0 &&
    password.length > 0 &&
    password2.length > 0
  const canSubmit = filled && !submitting

  const validate = () => {
    const next: Partial<Record<FieldKey, string>> = {}
    if (nickname.trim().length < 2) next.nickname = '昵称至少 2 个字'
    const no = studentNo.trim()
    if (!no) next.studentNo = '请输入学号'
    else if (!/^\d+$/.test(no)) next.studentNo = '学号只能是数字'
    else if (no.length !== STUDENT_NO_LEN) next.studentNo = `学号应为 ${STUDENT_NO_LEN} 位数字`
    if (password.length < 6) next.password = '密码至少 6 位'
    if (password2.length === 0) next.password2 = '请再次输入密码'
    else if (password2 !== password) next.password2 = '两次输入的密码不一致'
    return next
  }

  const submit = () => {
    if (submitting) return
    const next = validate()
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setSubmitting(true)
    // 真实实现：POST /auth/register；成功后账号为 UNVERIFIED
    setTimeout(() => {
      setSubmitting(false)
      setDone(true)
    }, 800)
  }

  const clearError = (key: FieldKey) => {
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }))
  }

  /* ---------------------------------------------------- 成功态（UNVERIFIED 引导） */

  if (done) {
    return (
      <View className="reg">
        <View className="reg__done">
          <View className="reg__big">
            <Image className="reg__big-ic" src={ICONS.checkCircleWhite} mode="aspectFit" />
          </View>
          <Text className="reg__done-title">注册成功</Text>
          <Text className="reg__done-text">
            账号已创建，当前状态为未认证。{'\n'}完成校园认证后才能发布闲置、发起交易。
          </Text>
          <Text className="reg__unver num">未认证 · UNVERIFIED</Text>

          <View className="reg__steps">
            <View className="reg__step">
              <View className="reg__step-n">
                <Text>1</Text>
              </View>
              <Text className="reg__step-tx">用教育邮箱收取验证码，完成校园认证</Text>
            </View>
            <View className="reg__step">
              <View className="reg__step-n">
                <Text>2</Text>
              </View>
              <Text className="reg__step-tx">
                认证后昵称旁会显示徽章，公开页面只展示徽章，不展示邮箱与学号
              </Text>
            </View>
          </View>

          <View
            className="reg__submit"
            onClick={() => void Taro.navigateTo({ url: '/pages/verify/index' })}
          >
            <Text>去校园认证</Text>
          </View>
          <View
            className="reg__line"
            onClick={() => void Taro.switchTab({ url: '/pages/home/index' })}
          >
            <Text>先随便逛逛</Text>
          </View>
          <Text className="reg__note">也可以稍后在「我的 → 校园认证」完成</Text>
        </View>
      </View>
    )
  }

  /* ---------------------------------------------------- 表单 */

  return (
    <View className="reg">
      <View className="reg__brandhead">
        <View className="reg__brandrow">
          {/* 设计稿：品牌渐变方块里是白色「鱼」字 */}
          <View className="reg__logo">
            <Text className="reg__logo-tx">鱼</Text>
          </View>
          <View className="reg__brandtxt">
            <Text className="reg__wordmark">创建账号</Text>
            <Text className="reg__slogan">校区会决定你看到的线下交易范围</Text>
          </View>
        </View>
      </View>

      <View className="reg__content">
        {/* ---- 昵称 ---- */}
        <View className="reg__field">
          <View className="reg__flabel">
            <Text>昵称</Text>
            <Text className="reg__opt">公开可见</Text>
          </View>
          <View
            className={`reg__input${focused === 'nickname' ? ' is-focus' : ''}${
              errors.nickname ? ' is-error' : ''
            }${submitting ? ' is-off' : ''}`}
          >
            <Image className="reg__input-ic" src={ICONS.user} mode="aspectFit" />
            <Input
              className="reg__val"
              maxlength={16}
              value={nickname}
              disabled={submitting}
              placeholder="例如：校园小林"
              placeholderClass="reg__ph"
              onInput={(event) => {
                setNickname(event.detail.value)
                clearError('nickname')
              }}
              onFocus={() => setFocused('nickname')}
              onBlur={() => setFocused(null)}
            />
          </View>
          {errors.nickname ? <Text className="reg__ferr">{errors.nickname}</Text> : null}
        </View>

        {/* ---- 学号 ---- */}
        <View className="reg__field">
          <View className="reg__flabel">
            <Text>学号</Text>
            <Text className="reg__opt">登录用</Text>
          </View>
          <View
            className={`reg__input${focused === 'studentNo' ? ' is-focus' : ''}${
              errors.studentNo ? ' is-error' : ''
            }${submitting ? ' is-off' : ''}`}
          >
            <Image className="reg__input-ic" src={ICONS.card} mode="aspectFit" />
            <Input
              className="reg__val num"
              type="number"
              maxlength={STUDENT_NO_LEN}
              value={studentNo}
              disabled={submitting}
              placeholder={`${STUDENT_NO_LEN} 位学号`}
              placeholderClass="reg__ph"
              onInput={(event) => {
                setStudentNo(event.detail.value)
                clearError('studentNo')
              }}
              onFocus={() => setFocused('studentNo')}
              onBlur={() => setFocused(null)}
            />
          </View>
          {errors.studentNo ? <Text className="reg__ferr">{errors.studentNo}</Text> : null}
        </View>

        {/* ---- 校区（胶囊单选） ---- */}
        <View className="reg__field">
          <View className="reg__flabel">
            <Text>校区</Text>
          </View>
          <View className="reg__pick">
            {CAMPUSES.map((item) => (
              <View
                key={item}
                className={`reg__pick-item${item === campus ? ' is-on' : ''}${
                  submitting ? ' is-off' : ''
                }`}
                onClick={() => {
                  if (!submitting) setCampus(item)
                }}
              >
                <Text>{item}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* ---- 密码 ---- */}
        <View className="reg__field">
          <View className="reg__flabel">
            <Text>密码</Text>
          </View>
          <View
            className={`reg__input${focused === 'password' ? ' is-focus' : ''}${
              errors.password ? ' is-error' : ''
            }${submitting ? ' is-off' : ''}`}
          >
            <Image className="reg__input-ic" src={ICONS.lock} mode="aspectFit" />
            <Input
              className={`reg__val${showPwd ? '' : ' reg__val--pwd'}`}
              password={!showPwd}
              value={password}
              disabled={submitting}
              placeholder="至少 6 位"
              placeholderClass="reg__ph"
              onInput={(event) => {
                setPassword(event.detail.value)
                clearError('password')
                if (password2) clearError('password2')
              }}
              onFocus={() => setFocused('password')}
              onBlur={() => setFocused(null)}
            />
            <View
              className={`reg__eye${showPwd ? ' is-on' : ''}${submitting ? ' is-off' : ''}`}
              onClick={() => {
                if (!submitting) setShowPwd((prev) => !prev)
              }}
            >
              <Image
                className="reg__eye-ic"
                src={showPwd ? ICONS.browse : ICONS.browseMuted}
                mode="aspectFit"
              />
            </View>
          </View>
          {errors.password ? <Text className="reg__ferr">{errors.password}</Text> : null}
        </View>

        {/* ---- 确认密码 ---- */}
        <View className="reg__field">
          <View className="reg__flabel">
            <Text>确认密码</Text>
          </View>
          <View
            className={`reg__input${focused === 'password2' ? ' is-focus' : ''}${
              errors.password2 ? ' is-error' : ''
            }${submitting ? ' is-off' : ''}`}
          >
            <Image className="reg__input-ic" src={ICONS.lock} mode="aspectFit" />
            <Input
              className="reg__val reg__val--pwd"
              password
              value={password2}
              disabled={submitting}
              placeholder="再输入一次"
              placeholderClass="reg__ph"
              onInput={(event) => {
                setPassword2(event.detail.value)
                clearError('password2')
              }}
              onFocus={() => setFocused('password2')}
              onBlur={() => setFocused(null)}
            />
          </View>
          {/* 两次一致时的正向反馈（设计稿的 .fok） */}
          {errors.password2 ? (
            <Text className="reg__ferr">{errors.password2}</Text>
          ) : pwd2Ok ? (
            <Text className="reg__fok">
              <Image className="reg__fok-ic" src={ICONS.checkAccent} mode="aspectFit" />
              两次输入一致
            </Text>
          ) : null}
        </View>

        <View className={`reg__submit${canSubmit ? '' : ' is-off'}`} onClick={submit}>
          {submitting ? <View className="reg__spin" /> : null}
          <Text>{submitting ? '注册中…' : '注册'}</Text>
        </View>

        <View className="reg__alt">
          <Text>已经有账号？</Text>
          <Text
            className="reg__alt-link"
            onClick={() => {
              if (submitting) return
              void Taro.navigateBack().catch(
                () => void Taro.navigateTo({ url: '/pages/login/index' }),
              )
            }}
          >
            去登录
          </Text>
        </View>

        <View className="reg__legal">
          <Text>注册即表示同意</Text>
          <Text className="reg__legal-link">《用户协议》</Text>
          <Text>与</Text>
          <Text className="reg__legal-link">《隐私政策》</Text>
        </View>
      </View>
    </View>
  )
}
