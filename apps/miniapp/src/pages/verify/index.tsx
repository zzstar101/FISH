import type { VerificationStatus } from '@fish/contracts/auth/verification'
import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { applyVerification, authSnapshot, useAuth } from '@/features/auth/store'
import {
  CAMPUS_EMAIL_DOMAIN,
  fetchVerificationStatus,
  isCampusEmail,
  sendVerificationCode,
  verifyCampusCode,
} from '@/features/verify/api'
import {
  sendErrorMessage,
  VERIFY_FOOTNOTE,
  VERIFY_INTRO_DESC,
  VERIFY_PRIVACY_EMPHASIS,
  VERIFY_PRIVACY_LEAD,
  VERIFY_PRIVACY_TAIL,
  verifyErrorMessage,
  verifyNeedsResend,
} from '@/features/verify/messages'
import { isApiError } from '@/lib/request'
import './index.scss'

/**
 * B3 校园认证（设计稿 `1改/校园认证页面（包括注册跳转页面）.html` 01–03 帧）。
 *
 * 四种状态全覆盖：未认证（填邮箱）→ 已发码（6 格输入 + 60 秒重发倒计时）
 * → 已认证（成功态 + 徽章一致性说明）→ 异常文案（码错误 / 已过期 / 过于频繁 / 域名不符）。
 *
 * **真实接线（#89）**：发码 / 校验 / 状态三个端点都在 `#68` 落地，本页不再有任何
 * mock 分支 —— 生产构建失败即显式报错，不回退 fixture。域名规则经契约的
 * `CampusEmailSchema` 校验（`isCampusEmail`），页面不写死教育邮箱域名；错误码到
 * 文案的映射在 `features/verify/messages.ts`。
 *
 * 登录态边界：三个端点都挂 `requireAuth`。会话失效时 `lib/request` 对 401
 * `UNAUTHENTICATED` 就地清会话 → `features/auth/store` 广播 `anonymous` →
 * 本页在守卫跳转落地前先渲染 `AuthRequired`，不会画一帧假数据。
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

/** `2026-05-06T…Z` → `2026-05-06`；拿不到就显示 `—`，不编造时间 */
function formatVerifiedAt(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  // 不用 `padStart`：Babel 目标是 iOS 9 / Android 5，项目未装 core-js（`useBuiltIns`
  // 为 false），而 `check:es5` 只做 acorn 语法解析、不检查 ES2017 内建是否存在
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export default function Verify() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null

  /**
   * 认证状态的**权威来源**是 `GET /verification/status`（脱敏邮箱 + 认证时间），
   * 请求未回来之前先用 `GET /me` 的 `authStatus` 顶着 —— 两者都是真实数据，
   * 不存在「先画一帧演示账号」的问题，也不会让已认证用户看到一帧「未认证」。
   */
  const [status, setStatus] = useState<VerificationStatus | null>(null)

  const verified = status ? status.authStatus === 'VERIFIED' : user?.authStatus === 'VERIFIED'
  const nickname = user?.nickname ?? ''
  const [stage, setStage] = useState<Stage>('email')

  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState('')
  const [left, setLeft] = useState(0)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  /**
   * 与 state 并行的**同 tick 守卫**：`setSending(true)` 要下一次渲染才可见，
   * 两次点击落在同一渲染里时 state 守卫会双双放行，于是真的发两次码 ——
   * 后端每日额度（邮箱 5 / 用户 10）会被白白消耗一次。
   */
  const sendingRef = useRef(false)
  const submittingRef = useRef(false)

  useEffect(() => {
    if (left <= 0) return
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [left])

  /**
   * 拉一次真实认证状态（成功态的教育邮箱 / 认证时间用它）。
   *
   * 依赖 `userId` 而不是整个 `authUser` 对象：换账号必须丢掉上一个账号的状态
   * （与 `pages/profile` 防串号同一理由），而同一账号的普通广播不该触发重拉。
   */
  useEffect(() => {
    setStatus(null)
    if (authStatus !== 'authed' || !userId) return
    let alive = true
    void fetchVerificationStatus()
      .then((next) => {
        // 绝不把已认证降级：本请求可能比用户刚完成的 verify 响应更晚回来
        if (alive) setStatus((prev) => (prev?.authStatus === 'VERIFIED' ? prev : next))
      })
      .catch(() => {
        // 失败不编造：成功态的教育邮箱 / 认证时间留 `—`，未认证分支照常可用
      })
    return () => {
      alive = false
    }
  }, [authStatus, userId])

  /** 邮箱打码：z***@gzasc.edu.cn（仅用于展示刚输入、尚未绑定的地址） */
  const maskEmail = (raw: string): string => {
    const [name = '', domain = ''] = raw.trim().split('@')
    if (!domain) return raw.trim()
    return `${name.slice(0, 1)}***@${domain}`
  }

  /** 发码失败落在当前可见的字段上：填邮箱阶段看邮箱行，输码阶段（重发）看码位下方的错误框 */
  const showSendError = (message: string) => {
    if (stage === 'code') setCodeError(message)
    else setEmailError(message)
  }

  /**
   * 认证响应只属于**发起请求的那个账号**。
   *
   * 请求可以飞行十几秒（`lib/request` 超时上限 15s），期间用户完全可能退出、换号登录。
   * 结果回来时若登录的已经不是同一个人，就必须整个丢弃 —— 否则 A 的 `VERIFIED` 会被
   * 写进 B 的全局 store（`applyVerification` 也按 `ownerId` 再挡一层）。
   */
  const ownedByCurrent = (ownerId: string): boolean => authSnapshot().user?.id === ownerId

  /** 后端说「已认证」时，把页面与 store 都收敛到已认证态；状态拿不到则返回 false，由调用方如实报错 */
  const convergeVerified = async (ownerId: string): Promise<boolean> => {
    const next = await fetchVerificationStatus().catch(() => null)
    if (!next || !ownedByCurrent(ownerId)) return false
    setStatus(next)
    applyVerification(ownerId, next)
    return true
  }

  /** 发送验证码：本地按契约校验域名 → 真调后端 → 起 60 秒倒计时 */
  const send = async () => {
    if (sendingRef.current || left > 0) return
    const trimmed = email.trim()
    if (!trimmed) {
      showSendError('请输入教育邮箱')
      return
    }
    if (!isCampusEmail(trimmed)) {
      showSendError(`请使用校园教育邮箱（如 ${CAMPUS_EMAIL_DOMAIN}）`)
      return
    }
    const ownerId = userId
    if (!ownerId) return
    sendingRef.current = true
    setEmailError('')
    setCodeError('')
    setSending(true)
    try {
      await sendVerificationCode(trimmed)
      setStage('code')
      setLeft(RESEND_SECONDS)
      setCode('')
      void Taro.showToast({ title: '验证码已发送', icon: 'none' })
    } catch (error) {
      if (isApiError(error)) {
        // 服务端已认证（例如另一端刚认证完）：不是发码失败，收敛到已认证态
        if (error.code === 'ALREADY_VERIFIED') {
          if (!(await convergeVerified(ownerId))) {
            showSendError('该账号已完成认证，但状态还没同步，请稍后重试')
          }
          return
        }
        showSendError(sendErrorMessage(error.code, error.message))
        return
      }
      showSendError('发送失败，请检查网络后重试')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  /**
   * 校验验证码。
   *
   * 成功后用 verify 的响应**就地**更新 store：该响应已经是权威的认证状态，
   * 「我的」页取数 effect 依赖 `[authStatus, authUser]`，换出新的 `user` 即会重拉
   * （见 `features/auth/store.ts` 的 `applyVerification`）。
   */
  const submit = async () => {
    if (submittingRef.current) return
    if (code.length !== CODE_LEN) {
      setCodeError(`请输入 ${CODE_LEN} 位验证码`)
      return
    }
    const ownerId = userId
    if (!ownerId) return
    submittingRef.current = true
    setSubmitting(true)
    setCodeError('')
    try {
      const next = await verifyCampusCode(email, code)
      if (!ownedByCurrent(ownerId)) return
      setStatus(next)
      applyVerification(ownerId, next)
    } catch (error) {
      if (isApiError(error)) {
        // 另一端 / 上一次已完成：不是错误，按已认证态收敛
        if (error.code === 'ALREADY_VERIFIED') {
          if (!(await convergeVerified(ownerId))) {
            setCodeError('该账号已完成认证，但状态还没同步，请稍后重试')
          }
          return
        }
        if (verifyNeedsResend(error.code)) setLeft(0)
        setCodeError(verifyErrorMessage(error.code, error.message))
        return
      }
      setCodeError('认证失败，请检查网络后重试')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  /**
   * 登录门禁**排在所有分支之前**：会话失效（401 清会话 → 广播 anonymous）时，
   * 即便 `status` 还留着刚拿到的 VERIFIED，也不能先画一帧 `user=null` 的成功页
   * （头像首字与昵称都会是空的），必须等守卫把页面跳去登录。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  /* ---------------------------------------------------- 已认证态 */

  if (verified) {
    /** 「返回我的主页」：`pages/profile` 是 Tab 页，只能用 `switchTab` */
    const goHome = () =>
      void Taro.switchTab({ url: '/pages/profile/index' }).catch(
        () => void Taro.showToast({ title: '打开失败，请重试', icon: 'none' }),
      )

    return (
      <View className="verify">
        <View className="verify__bg" />
        <NavBar />

        <View className="verify__content">
          <View className="verify__okwrap">
            <View className="verify__okdisc">
              <View className="verify__okring">
                <View className="verify__okcheck" />
              </View>
            </View>
            <Text className="verify__oktitle">教育邮箱已验证</Text>
            <Text className="verify__oktext">你现在可以发布闲置、接受交易，并获得认证徽章。</Text>
          </View>

          <View className="verify__card">
            <Text className="verify__card-title">徽章展示位置</Text>
            <Text className="verify__card-sub">个人页 / 卖家页 · 同一徽章</Text>

            <View className="verify__badgerow">
              <View className="verify__av">
                <Text className="verify__av-tx">{nickname.slice(0, 1)}</Text>
              </View>
              <View className="verify__badgeinfo">
                <View className="verify__nameRow">
                  <Text className="verify__name">{nickname}</Text>
                  <Image className="verify__tick" src={ICONS.verifiedAccent} mode="aspectFit" />
                </View>
                <Text className="verify__badge-sub">我的 · 个人页</Text>
              </View>
              <Text className="verify__badge-tag">已认证</Text>
            </View>

            <View className="verify__badgerow">
              <View className="verify__av">
                <Text className="verify__av-tx">{nickname.slice(0, 1)}</Text>
              </View>
              <View className="verify__badgeinfo">
                <View className="verify__nameRow">
                  <Text className="verify__name">{nickname}</Text>
                  <Image className="verify__tick" src={ICONS.verifiedAccent} mode="aspectFit" />
                </View>
                <Text className="verify__badge-sub">商品详情 · 卖家页</Text>
              </View>
              <Text className="verify__badge-tag">已认证</Text>
            </View>
          </View>

          {/* 认证信息来自 `GET /verification/status`（邮箱只给脱敏形式）；拿不到就显示 `—` */}
          <View className="verify__card">
            <View className="verify__prow">
              <Text className="verify__pname">教育邮箱</Text>
              <Text className="verify__ptag num">{status?.maskedEmail ?? '—'}</Text>
            </View>
            <View className="verify__prow">
              <Text className="verify__pname">认证时间</Text>
              <Text className="verify__ptag num">{formatVerifiedAt(status?.verifiedAt)}</Text>
            </View>
          </View>

          <View className="verify__privacy">
            <Text className="verify__privacy-tx">
              {VERIFY_PRIVACY_LEAD}
              <Text className="verify__privacy-b">{VERIFY_PRIVACY_EMPHASIS}</Text>
              {VERIFY_PRIVACY_TAIL}
            </Text>
          </View>

          <View className="verify__btn-main verify__btn-home" onClick={goHome}>
            <Text>返回我的主页</Text>
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
          教育邮箱<Text className="verify__title-hl">验证</Text>
        </Text>
        <Text className="verify__meta num">认证后解锁发布 / 交易 · 当前 UNVERIFIED</Text>
      </View>

      <View className="verify__content">
        {/* ---- 未认证说明（稿 01 帧：白卡 + 左侧渐变圆盘 + 右侧黄胶囊） ---- */}
        <View className="verify__vcard">
          <View className="verify__vcard-disc">
            <Image className="verify__vcard-ic" src={ICONS.shieldLine} mode="aspectFit" />
          </View>
          <View className="verify__vcard-txt">
            <Text className="verify__vcard-title">未认证</Text>
            <Text className="verify__vcard-desc">{VERIFY_INTRO_DESC}</Text>
          </View>
          <Text className="verify__chip">未认证</Text>
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
                placeholder={`yourname${CAMPUS_EMAIL_DOMAIN}`}
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
              // 5 分钟与后端 `CODE_TTL_MINUTES`（apps/api/src/modules/auth/verification-store.ts，
              // 邮件正文同源）一致；该常量未进契约，后端改了要同步这里
              <Text className="verify__fhelp">仅支持校园教育邮箱，验证码 5 分钟内有效。</Text>
            )}

            <View
              className={`verify__btn-main${sending ? ' is-off' : ''}`}
              onClick={() => void send()}
            >
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
                  setCodeError('')
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

            {/* 稿 02 帧 `.resend` 是**两个都在**：左侧说明 + 右侧胶囊钮，倒计时期间按钮置灰
                （`.rb.is-off`）而不是把按钮换成一行字 —— 后者会让这一行在倒计时结束时
                左右跳一次。按钮的点击在 `send()` 里已有 `left > 0` 守卫，置灰只是外观。 */}
            <View className="verify__resend">
              <Text className="verify__resend-tx num">
                {left > 0 ? `没收到？${left}s 后可重新发送` : '没收到？可以重新发送验证码'}
              </Text>
              <View
                className={`verify__resend-btn${left > 0 ? ' is-off' : ''}`}
                onClick={() => void send()}
              >
                <Image className="verify__resend-ic" src={ICONS.clock} mode="aspectFit" />
                <Text>重新发送</Text>
              </View>
            </View>

            <View
              className={`verify__btn-main${
                code.length === CODE_LEN && !submitting ? '' : ' is-off'
              }`}
              onClick={() => void submit()}
            >
              {submitting ? <View className="verify__spin" /> : null}
              <Text>{submitting ? '认证中…' : '确认认证'}</Text>
            </View>
          </View>
        ) : null}

        {/* 稿 01 帧把这条说明做成了居中脚注（.fnote 居中变体） */}
        <Text className="verify__fnote">{VERIFY_FOOTNOTE}</Text>
      </View>
    </View>
  )
}
