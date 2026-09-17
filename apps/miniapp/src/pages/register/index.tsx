import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import { signUp, useAuth } from '@/features/auth/store'
import { ApiError } from '@/lib/request'
import type { Campus } from '@/mock/types'
import './index.scss'

/**
 * B2 注册（设计稿 `设计稿_B2-register.html`）。
 *
 * 与 B1 同结构，多出「昵称 / 校区单选 / 二次密码」，且注册成功后账号是
 * **UNVERIFIED** —— 成功态要引导去校园认证（B3），这是设计稿第 03 帧的重点。
 *
 * 数据：`POST /auth/register`。契约是**注册即登录**（响应体与 `/me` 同构），
 * 所以成功态同时意味着已登录：`features/auth/store` 会广播 `authed`，
 * 会话 cookie 由 `@/lib/request` 落盘。
 */

const STUDENT_NO_LEN = 12
/** 密码 8~32 位、昵称 1~20 字：直接对齐契约，前端不另定一套 */
const PASSWORD_MIN = 8
const PASSWORD_MAX = 32
const NICKNAME_MAX = 20
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

  const { status } = useAuth()

  /**
   * 本次注册是否刚刚成功。
   *
   * 用 `ref` 而不是 `done` 状态：`signUp()` 内部先 `emit(authed)` 再 resolve，
   * React 会因此先跑一次 `(authed, false)` 的 effect —— 那时 `setDone(true)` 还没执行，
   * 用状态判断会把成功态直接抢成跳首页（「去校园认证」入口不可达）。
   * ref 在 effect 执行时读的是当前值，不受那次提前渲染影响。
   */
  const justRegistered = useRef(false)

  /** 已登录用户不该停在注册页（刚注册成功那次除外，要留在成功态引导去认证） */
  useEffect(() => {
    if (status !== 'authed' || justRegistered.current) return
    void Taro.switchTab({ url: '/pages/home/index' })
  }, [status])

  const pwd2Ok = password2.length > 0 && password2 === password
  const filled =
    nickname.trim().length > 0 &&
    studentNo.trim().length > 0 &&
    password.length > 0 &&
    password2.length > 0
  const canSubmit = filled && !submitting

  const validate = () => {
    const next: Partial<Record<FieldKey, string>> = {}
    const nick = nickname.trim()
    if (!nick) next.nickname = '请输入昵称'
    else if (nick.length > NICKNAME_MAX) next.nickname = `昵称最多 ${NICKNAME_MAX} 个字`
    const no = studentNo.trim()
    if (!no) next.studentNo = '请输入学号'
    else if (!/^\d+$/.test(no)) next.studentNo = '学号只能是数字'
    else if (no.length !== STUDENT_NO_LEN) next.studentNo = `学号应为 ${STUDENT_NO_LEN} 位数字`
    if (password.length < PASSWORD_MIN) next.password = `密码至少 ${PASSWORD_MIN} 位`
    else if (password.length > PASSWORD_MAX) next.password = `密码最多 ${PASSWORD_MAX} 位`
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
    void (async () => {
      try {
        // 注册即登录：成功后 store 广播 `authed`，无需再打 `/auth/login`
        await signUp({
          studentNo: studentNo.trim(),
          password,
          nickname: nickname.trim(),
          campus,
        })
        // **先**置这个 ref 再改状态：`signUp()` 已经 emit 过 `authed`，
        // 那次提前渲染的 effect 不该把成功态抢走（见上面的说明）
        justRegistered.current = true
        setSubmitting(false)
        setDone(true)
      } catch (error) {
        setSubmitting(false)
        if (error instanceof ApiError && error.code === 'STUDENT_NO_TAKEN') {
          setErrors({ studentNo: '这个学号已经注册过了，直接去登录' })
          return
        }
        if (error instanceof ApiError) {
          // 其余错误码（422 的后端文案固定是「请求参数不合法」、5xx 等）不是某一个
          // 字段的问题，挂到「学号」下面只会误导。
          void Taro.showToast({ title: error.message, icon: 'none' })
          return
        }
        void Taro.showToast({ title: '连不上服务器，请确认后端已启动', icon: 'none' })
      }
    })()
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
              maxlength={NICKNAME_MAX}
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
              placeholder="至少 8 位"
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
