import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import brandMark from '@/assets/brand/brand-mark.png'
import brandWordmark from '@/assets/brand/brand-wordmark.png'
import { ICONS } from '@/assets/lib-icons'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { signUp, useAuth } from '@/features/auth/store'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError } from '@/lib/request'
import type { Campus } from '@/mock/types'
import './index.scss'

/**
 * 注册（设计稿 `小程序1版register.html`）。
 *
 * **契约口径**（`packages/contracts/src/auth/session.ts`）：
 * `POST /auth/register` 收 `studentNo` + `password` + `nickname` + `campus`，且**注册即登录**
 * （响应体与 `/me` 同构）。所以成功后的下一步不是「登录」，而是**注册成功提示页**
 * （`pages/register-success/index`，设计稿 `小程序第1版，注册后提示页register-success.html`）。
 *
 * 与旧版（2改 `设计稿_B2-register.html`）的差异，都按新稿走：
 * - 不再有「二次密码」字段（契约里没有它，稿子也没有）；
 * - 校区从两枚胶囊单选改成一行「值 + 下拉箭头」，点开用原生 `showActionSheet`；
 * - 成功态不再是页内替换，而是独立页面。
 *
 * 与稿子的**一处文案偏差**（已与 Owner 确认）：稿子的 tagline 是「认证状态由学号自动判定」、
 * 学号下方是「20 开头的学号会通过校园认证」。这两句描述的其实是**当前 Mock Provider 的判定规则**
 * （`apps/api/src/app.ts` 注明：任意 20 开头 12 位学号都返回 VERIFIED，不可当安全依据），
 * 而真实 Provider（#68）走的是**教育邮箱验证码**（见本页之后的注册成功页第 1 步），
 * 所以照稿展示会给用户一个将来必然错误的承诺。改成不承诺具体机制的说法。
 */

const STUDENT_NO_LEN = 12
/** 密码 8~32 位、昵称 1~20 字：直接对齐契约，前端不另定一套 */
const PASSWORD_MIN = 8
const PASSWORD_MAX = 32
const NICKNAME_MAX = 20
/** 校区值域对齐 `auth/user.ts` 的 Campus */
const CAMPUSES: Campus[] = ['肇庆', '广州']

type FieldKey = 'studentNo' | 'password' | 'nickname'

export default function Register() {
  const [studentNo, setStudentNo] = useState('')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [campus, setCampus] = useState<Campus>('肇庆')
  const [focused, setFocused] = useState<FieldKey | null>(null)
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({})
  const [submitting, setSubmitting] = useState(false)

  const { status } = useAuth()
  const nav = useMemo(() => readNavMetrics(), [])

  /**
   * 本次注册是否正在进行/刚刚成功。
   *
   * **必须在 `await signUp()` 之前置位**：`signUp()` 内部先 `emit(authed)` 再 resolve，
   * 那次「已登录」的重渲染会触发下面的 effect，而 effect 与 `await` 的后续是**同一批
   * 微任务**——放在 await 之后置位会抢跑，结果是注册成功却被弹回首页（实测踩到过）。
   */
  const justRegistered = useRef(false)

  /** 已登录用户不该停在注册页（注册流程自己造成的「已登录」除外，要留在成功页引导去认证） */
  useEffect(() => {
    // 演示构建里同上：不弹走，否则注册页永远看不到（见 `features/auth/demo.ts`）
    if (DEMO_AUTH_ENABLED || status !== 'authed' || justRegistered.current) return
    void Taro.switchTab({ url: '/pages/home/index' })
  }, [status])

  const filled = studentNo.trim().length > 0 && password.length > 0 && nickname.trim().length > 0
  const canSubmit = filled && !submitting

  const validate = () => {
    const next: Partial<Record<FieldKey, string>> = {}
    const no = studentNo.trim()
    if (!no) next.studentNo = '请输入学号'
    else if (!/^\d+$/.test(no)) next.studentNo = '学号只能是数字'
    else if (no.length !== STUDENT_NO_LEN) next.studentNo = `学号应为 ${STUDENT_NO_LEN} 位数字`
    if (password.length < PASSWORD_MIN) next.password = `密码至少 ${PASSWORD_MIN} 位`
    else if (password.length > PASSWORD_MAX) next.password = `密码最多 ${PASSWORD_MAX} 位`
    const nick = nickname.trim()
    if (!nick) next.nickname = '请输入昵称'
    else if (nick.length > NICKNAME_MAX) next.nickname = `昵称最多 ${NICKNAME_MAX} 个字`
    return next
  }

  const toast = (title: string) => void Taro.showToast({ title, icon: 'none' })

  /** 校区：稿子是一行「值 + 下拉箭头」，点开用原生选择器（仓库既有的 showActionSheet 用法） */
  const pickCampus = () => {
    if (submitting) return
    void Taro.showActionSheet({ itemList: CAMPUSES })
      .then((res) => {
        const picked = CAMPUSES[res.tapIndex]
        if (picked) setCampus(picked)
      })
      .catch(() => {
        /* 用户取消：什么都不做 */
      })
  }

  const submit = () => {
    if (submitting) return
    const next = validate()
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setSubmitting(true)
    // 先标记：接下来那次「已登录」是本页自己造成的，不要被弹回首页（见上面的说明）
    justRegistered.current = true
    void (async () => {
      try {
        // 注册即登录：成功后 store 广播 `authed`，无需再打 `/auth/login`
        await signUp({
          studentNo: studentNo.trim(),
          password,
          nickname: nickname.trim(),
          campus,
        })
        // 用 redirectTo 而不是 navigateTo：成功页不该能返回注册表单。
        // 跳转失败要有出口：此时账号已建好且已登录，不能把人留在「表单全灰」的注册页上。
        void Taro.redirectTo({ url: '/pages/register-success/index' }).catch(() => {
          void Taro.switchTab({ url: '/pages/home/index' })
        })
      } catch (error) {
        // 失败了要撤回标记，否则用户改完再提交时这条短路会一直生效
        justRegistered.current = false
        setSubmitting(false)
        if (isApiError(error) && error.code === 'STUDENT_NO_TAKEN') {
          setErrors({ studentNo: '这个学号已经注册过了，直接去登录' })
          return
        }
        if (isApiError(error)) {
          // 其余错误码（422 的后端文案固定是「请求参数不合法」、5xx 等）不是某一个字段的
          // 问题，挂到「学号」下面只会误导。
          toast(error.message)
          return
        }
        toast('连不上服务器，请确认后端已启动')
      }
    })()
  }

  const goLogin = () => {
    // 从登录页跳来的：返回即可；直接进来的（分享 / 扫码）：换成登录页
    void Taro.navigateBack().catch(() => void Taro.redirectTo({ url: '/pages/login/index' }))
  }

  return (
    <View className="reg">
      <View className="reg__bg" />

      <View className="reg__body" style={{ paddingTop: `${nav.totalHeight}px` }}>
        {/*
          返回钮落在**微信胶囊那一行**（不在状态栏后面）：top 用运行时反推的
          「状态栏 + 内容行中线」，而不是写死的 rpx —— 各机型状态栏高度不一样。
        */}
        <View
          className="reg__back"
          style={{ top: `${nav.statusBarHeight + nav.contentHeight / 2}px` }}
          onClick={goLogin}
        >
          <Image className="reg__back-ic" src={ICONS.backInk} mode="aspectFit" />
        </View>

        {/* ---- 品牌区 ---- */}
        <View className="reg__brand">
          <Image className="reg__mark" src={brandMark} mode="aspectFit" />
          <Image className="reg__wordmark" src={brandWordmark} mode="aspectFit" />
          <Text className="reg__tagline">注册后即完成登录，认证状态以学校认证结果为准</Text>
        </View>

        {/* ---- 表单卡 ---- */}
        <View className="reg__card">
          <View className="reg__form">
            {/* 学号 */}
            <View className="reg__field">
              <Text className="reg__label">学号</Text>
              <View
                className={`reg__input${focused === 'studentNo' ? ' is-focus' : ''}${
                  errors.studentNo ? ' is-error' : ''
                }`}
              >
                <Input
                  className="reg__val num"
                  type="number"
                  maxlength={STUDENT_NO_LEN}
                  value={studentNo}
                  disabled={submitting}
                  placeholder="例如 202101000001"
                  placeholderClass="reg__ph"
                  onInput={(event) => {
                    setStudentNo(event.detail.value)
                    if (errors.studentNo) setErrors((prev) => ({ ...prev, studentNo: undefined }))
                  }}
                  onFocus={() => setFocused('studentNo')}
                  onBlur={() => setFocused(null)}
                />
              </View>
              {errors.studentNo ? (
                <Text className="reg__err">{errors.studentNo}</Text>
              ) : (
                <Text className="reg__help">12 位数字；认证状态需完成校园认证后更新</Text>
              )}
            </View>

            {/* 密码 */}
            <View className="reg__field">
              <Text className="reg__label">密码</Text>
              <View
                className={`reg__input${focused === 'password' ? ' is-focus' : ''}${
                  errors.password ? ' is-error' : ''
                }`}
              >
                <Input
                  className="reg__val reg__val--pwd"
                  password
                  value={password}
                  disabled={submitting}
                  placeholder="8–32 位"
                  placeholderClass="reg__ph"
                  onInput={(event) => {
                    setPassword(event.detail.value)
                    if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }))
                  }}
                  onFocus={() => setFocused('password')}
                  onBlur={() => setFocused(null)}
                />
              </View>
              {errors.password ? <Text className="reg__err">{errors.password}</Text> : null}
            </View>

            {/* 昵称 */}
            <View className="reg__field">
              <Text className="reg__label">昵称</Text>
              <View
                className={`reg__input${focused === 'nickname' ? ' is-focus' : ''}${
                  errors.nickname ? ' is-error' : ''
                }`}
              >
                <Input
                  className="reg__val reg__val--nick"
                  maxlength={NICKNAME_MAX}
                  value={nickname}
                  disabled={submitting}
                  placeholder="1–20 个字符"
                  placeholderClass="reg__ph"
                  onInput={(event) => {
                    setNickname(event.detail.value)
                    if (errors.nickname) setErrors((prev) => ({ ...prev, nickname: undefined }))
                  }}
                  onFocus={() => setFocused('nickname')}
                  onBlur={() => setFocused(null)}
                />
              </View>
              {errors.nickname ? <Text className="reg__err">{errors.nickname}</Text> : null}
            </View>

            {/* 校区 */}
            <View className="reg__field">
              <Text className="reg__label">校区</Text>
              <View className="reg__input reg__input--tap" onClick={pickCampus}>
                <Text className="reg__val">{campus}</Text>
                <Image className="reg__chev" src={ICONS.chevronDownMuted} mode="aspectFit" />
              </View>
            </View>

            {/* 主 CTA */}
            <View className={`reg__cta${canSubmit ? '' : ' is-off'}`} onClick={submit}>
              {submitting ? <View className="reg__spin" /> : null}
              <Text>{submitting ? '注册中…' : '注册并登录'}</Text>
            </View>
          </View>
        </View>

        {/* ---- 去登录 ---- */}
        <View className="reg__alt">
          <Text>已经有账号？</Text>
          <Text className="reg__alt-lk" onClick={goLogin}>
            登录
          </Text>
        </View>
      </View>
    </View>
  )
}
