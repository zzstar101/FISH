import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import { eduEmailOk, ME, verifyState } from '@/mock/api'
import './index.scss'

/**
 * B3 校园认证（设计稿 `设计稿_B3-verify.html`）。
 *
 * 四种状态全覆盖：未认证（填邮箱）→ 已发码（6 格输入 + 60 秒重发倒计时）
 * → 已认证（成功态 + 徽章一致性说明）→ 异常文案（码错误 / 已过期 / 过于频繁 / 域名不符）。
 *
 * **两点与实现的边界**：
 * 1. 后端无此端点（`BLOCKED: #68`），因此数据来自 `mock/api`，认证动作停在本地校验；
 * 2. `apps/api` 的注释明确写过「当前 Mock Provider 对任意 20 开头 12 位学号都返回 VERIFIED，
 *    不可当安全依据」——所以这里**只做前端体验**，不宣称认证结果可信。
 *
 * 域名规则经 `eduEmailOk()` 走 api 层而不是写死在页面里：交付要求
 * 「Verification Provider 要可替换，前端不要写死教育邮箱的域名逻辑」。
 */

/** 重发倒计时秒数（设计稿：60 秒） */
const RESEND_SECONDS = 60
const CODE_LEN = 6

/**
 * 6 个码位的稳定 id：这里「位置即身份」，所以在模块级生成一次，
 * 而不是拿渲染下标当 key（`noArrayIndexKey`）。
 */
const CODE_SLOTS = Array.from({ length: CODE_LEN }, (_, index) => ({
  id: `verify-cell-${index}`,
  index,
}))

type Stage = 'email' | 'code'

export default function Verify() {
  const state = verifyState()

  /** 已认证用户进来：整页替换为认证状态卡（设计稿第 04 帧的状态边界） */
  const verified = state.state === 'VERIFIED'
  const [stage, setStage] = useState<Stage>('email')

  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState('')
  const [left, setLeft] = useState(0)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (left <= 0) return
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [left])

  /** 邮箱打码：z***@stu.edu.cn */
  const maskEmail = (raw: string): string => {
    const [name = '', domain = ''] = raw.split('@')
    if (!domain) return raw
    return `${name.slice(0, 1)}***@${domain}`
  }

  /** 发送验证码：先本地校验域名，再起 60 秒倒计时 */
  const send = () => {
    if (sending || left > 0) return
    const trimmed = email.trim()
    if (!trimmed) {
      setEmailError('请输入教育邮箱')
      return
    }
    if (!eduEmailOk(trimmed)) {
      setEmailError('请使用校园教育邮箱（如 @stu.edu.cn）')
      return
    }
    setEmailError('')
    setSending(true)
    setTimeout(() => {
      setSending(false)
      setStage('code')
      setLeft(RESEND_SECONDS)
      setCode('')
      setCodeError('')
      void Taro.showToast({ title: '验证码已发送', icon: 'none' })
    }, 700)
  }

  const submit = () => {
    if (submitting) return
    if (code.length !== CODE_LEN) {
      setCodeError(`请输入 ${CODE_LEN} 位验证码`)
      return
    }
    setSubmitting(true)
    setCodeError('')
    setTimeout(() => {
      setSubmitting(false)
      // 真实实现要调后端校验；这里只提示，不谎报已通过
      void Taro.showToast({ title: '认证接口待接入', icon: 'none' })
    }, 800)
  }

  /* ---------------------------------------------------- 已认证态 */

  if (verified) {
    return (
      <View className="verify">
        <View className="verify__bg" />
        <NavBar />

        <View className="verify__content">
          <View className="verify__okwrap">
            <View className="verify__okdisc">
              <Image className="verify__okic" src={ICONS.checkCircleWhite} mode="aspectFit" />
            </View>
            <Text className="verify__oktitle">校园认证已通过</Text>
            <Text className="verify__oktext">你现在可以发布闲置、接受交易，并获得认证徽章。</Text>
          </View>

          <View className="verify__card">
            <Text className="verify__card-title">徽章展示位置</Text>
            <Text className="verify__card-sub">个人页 / 卖家页 · 同一徽章</Text>

            <View className="verify__badgerow">
              <View className="verify__av">
                <Text className="verify__av-tx">{ME.nickname.slice(0, 1)}</Text>
              </View>
              <View className="verify__badgeinfo">
                <View className="verify__nameRow">
                  <Text className="verify__name">{ME.nickname}</Text>
                  <Image className="verify__tick" src={ICONS.verifiedAccent} mode="aspectFit" />
                </View>
                <Text className="verify__badge-sub">我的 · 个人页</Text>
              </View>
              <Text className="verify__badge-tag">已认证</Text>
            </View>
          </View>

          <View className="verify__card">
            <View className="verify__prow">
              <Text className="verify__pname">教育邮箱</Text>
              <Text className="verify__ptag num">{state.email ?? '—'}</Text>
            </View>
            <View className="verify__prow">
              <Text className="verify__pname">认证时间</Text>
              <Text className="verify__ptag num">{state.verifiedAt ?? '—'}</Text>
            </View>
          </View>

          <View className="verify__note">
            <Image className="verify__note-ic" src={ICONS.info} mode="aspectFit" />
            <Text className="verify__note-tx">
              公开页面只展示认证徽章，不展示邮箱、学号与班级；如需更换邮箱，需先解除当前认证。
            </Text>
          </View>

          <View
            className="verify__btn-line"
            onClick={() =>
              void Taro.showModal({
                title: '解除校园认证？',
                content: '解除后需要重新认证才能发布闲置与发起交易。',
                confirmText: '解除认证',
                cancelText: '再想想',
              })
            }
          >
            <Text>解除认证</Text>
          </View>
        </View>
      </View>
    )
  }

  /* ---------------------------------------------------- 未认证：填邮箱 / 输码 */

  return (
    <View className="verify">
      <View className="verify__bg" />
      <NavBar />

      <View className="verify__head">
        <Text className="verify__title">
          校园<Text className="verify__title-hl">认证</Text>
        </Text>
        <Text className="verify__meta num">认证后解锁发布 / 交易 · 当前 UNVERIFIED</Text>
      </View>

      <View className="verify__content">
        {/* ---- 未认证说明 ---- */}
        <View className="verify__status">
          <Text className="verify__status-tag">未认证</Text>
          <Text className="verify__status-tx">用学校邮箱验证在校身份，公开页面只展示徽章。</Text>
        </View>

        {/* ---- 邮箱（发码后变成只读行 + 修改） ---- */}
        {stage === 'email' ? (
          <View className="verify__field">
            <View className="verify__flabel">
              <Text>教育邮箱</Text>
              <Text className="verify__req">* 必填</Text>
            </View>
            <View className={`verify__input${emailError ? ' is-error' : ''}`}>
              <Image className="verify__input-ic" src={ICONS.mail} mode="aspectFit" />
              <Input
                className="verify__val"
                type="text"
                value={email}
                placeholder="yourname@stu.edu.cn"
                placeholderClass="verify__ph"
                onInput={(event) => {
                  setEmail(event.detail.value)
                  setEmailError('')
                }}
              />
            </View>
            {emailError ? (
              <Text className="verify__ferr">{emailError}</Text>
            ) : (
              <Text className="verify__fhelp">仅支持校园教育邮箱，验证码 10 分钟内有效。</Text>
            )}

            <View className={`verify__btn-main${sending ? ' is-off' : ''}`} onClick={send}>
              {sending ? <View className="verify__spin" /> : null}
              <Text>{sending ? '发送中…' : '发送验证码'}</Text>
            </View>
          </View>
        ) : (
          <View className="verify__field">
            <View className="verify__flabel">
              <Text>教育邮箱</Text>
            </View>
            <View className="verify__input is-readonly">
              <Image className="verify__input-ic" src={ICONS.mail} mode="aspectFit" />
              <Text className="verify__val num">{maskEmail(email)}</Text>
              <Text
                className="verify__edit"
                onClick={() => {
                  setStage('email')
                  setLeft(0)
                }}
              >
                修改
              </Text>
            </View>
          </View>
        )}

        {/* ---- 验证码 6 格 ---- */}
        {stage === 'code' ? (
          <View className="verify__field">
            <View className="verify__flabel">
              <Text>6 位验证码</Text>
              <Text className="verify__opt num">6 位数字</Text>
            </View>

            <View className="verify__cells">
              {CODE_SLOTS.map((slot) => {
                const ch = code[slot.index] ?? ''
                return (
                  <View
                    key={slot.id}
                    className={`verify__cell${ch ? ' is-filled' : ''}${
                      codeError ? ' is-bad' : ''
                    }${slot.index === code.length && !codeError ? ' is-focus' : ''}`}
                  >
                    <Text className="verify__cell-tx num">{ch}</Text>
                  </View>
                )
              })}
              <Input
                className="verify__cells-input"
                type="number"
                maxlength={CODE_LEN}
                value={code}
                onInput={(event) => {
                  setCode(event.detail.value.replace(/\D/g, '').slice(0, CODE_LEN))
                  setCodeError('')
                }}
              />
            </View>

            {codeError ? (
              <View className="verify__errbox">
                <Image className="verify__err-ic" src={ICONS.warn} mode="aspectFit" />
                <Text className="verify__err-tx">{codeError}</Text>
              </View>
            ) : null}

            <View className="verify__resend">
              <Text className="verify__resend-tx">没收到？</Text>
              {left > 0 ? (
                <Text className="verify__resend-wait num">{left}s 后可重新发送</Text>
              ) : (
                <Text className="verify__resend-act" onClick={send}>
                  重新发送
                </Text>
              )}
            </View>

            <View
              className={`verify__btn-main${
                code.length === CODE_LEN && !submitting ? '' : ' is-off'
              }`}
              onClick={submit}
            >
              {submitting ? <View className="verify__spin" /> : null}
              <Text>{submitting ? '认证中…' : '确认认证'}</Text>
            </View>
          </View>
        ) : null}

        <View className="verify__note">
          <Image className="verify__note-ic" src={ICONS.info} mode="aspectFit" />
          <Text className="verify__note-tx">
            认证信息仅用于核验身份，不会公开展示邮箱、学号与班级。
          </Text>
        </View>
      </View>
    </View>
  )
}
