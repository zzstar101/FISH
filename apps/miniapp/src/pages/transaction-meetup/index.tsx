import { Image, Input, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import {
  findListing,
  findTransaction,
  formatAmount,
  getUser,
  meetupCode,
  newMeetupCode,
  type MockListing,
  type MockMeetupCode,
  type MockTransaction,
  type MockUser,
} from '@/mock/api'
import './index.scss'

/**
 * A2 交易码 / 面交确认（设计稿 `设计稿_A2-transaction-meetup.html`）。
 *
 * 设计稿画了四种状态，本页全部实现：
 * 1. 待面交 —— 6 位码 + 二维码 + 倒计时 + 刷新；
 * 2. 手动输入对方码 —— 6 格输入，支持整串粘贴；
 * 3. 已完成 —— 成功态（交易码失效）；
 * 4. 异常 —— 码已过期 / 码错误 / 非参与者。
 *
 * **与后端契约的边界**：PR #83（交易码契约）被 CHANGES_REQUESTED，
 * 后端要求先统一 #70 协议（`transaction_meetup_tokens` vs `challenges` 还没定）。
 * 因此本页**只做 UI 与交互**，数据经 `mock/api` 取，且**不发明**
 * `challengeId` / `verifiedRole` 之类的字段。接真实实现时替换 api 层即可，页面不动。
 *
 * 安全约束（设计稿原文）：交易码是一次性凭证，**不把 transactionId 当凭证展示或缓存**。
 */

/** 倒计时秒数 → `04:38` */
function clockText(total: number): string {
  const safe = Math.max(0, Math.floor(total))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`
}

export default function TransactionMeetup() {
  const router = useRouter<{ id?: string }>()
  const txId = router.params.id ?? ''

  const [transaction, setTransaction] = useState<MockTransaction | null>(null)
  const [listing, setListing] = useState<MockListing | null>(null)
  const [counterpart, setCounterpart] = useState<MockUser | null>(null)
  const [code, setCode] = useState<MockMeetupCode | null>(null)

  /** 码的有效期倒计时（秒），由 mock 的 expiresInSec 起算 */
  const [left, setLeft] = useState(0)
  /** 手动输入：6 位数字的字符数组，索引即格子位置 */
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', ''])
  /** 手动输入的错误提示（码错误 / 过期），空串表示无错误 */
  const [inputError, setInputError] = useState('')
  /** 提交中锁：防重复成交 */
  const [submitting, setSubmitting] = useState(false)
  /** 校验通过的提示（演示用，不真的成交） */
  const [flash, setFlash] = useState('')
  const rotateSeed = useRef(0)

  useLoad(() => {
    const tx = findTransaction(txId)
    setTransaction(tx ?? null)
    const found = tx ? meetupCode(tx.id) : null
    setCode(found)
    setLeft(found?.expiresInSec ?? 0)
    if (tx) {
      setListing(findListing(tx.listingId) ?? null)
      setCounterpart(getUser(tx.counterpartId))
    }
  })

  /* 倒计时：只在 ACTIVE 且有剩余秒数时走，归零即转「已过期」 */
  useEffect(() => {
    if (!code || code.state !== 'ACTIVE' || left <= 0) return
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [code, left])

  useEffect(() => {
    if (code && code.state === 'ACTIVE' && left === 0) {
      setCode({ ...code, state: 'EXPIRED' })
    }
  }, [code, left])

  const notParticipant = !transaction || !code || code.state === 'NOT_PARTICIPANT'
  const expired = code?.state === 'EXPIRED'
  const done = transaction?.status === 'COMPLETED'

  const openConversation = () => {
    if (!transaction) return
    void Taro.navigateTo({ url: `/pages/conversation/index?id=${transaction.conversationId}` })
  }

  const goOrders = () => {
    void Taro.navigateTo({ url: '/pages/orders/index' })
  }

  /** 刷新交易码：换一组数字并重置倒计时（真实实现由后端重新签发） */
  const rotate = () => {
    if (!transaction) return
    rotateSeed.current += 1
    setCode({
      code: newMeetupCode(rotateSeed.current),
      state: 'ACTIVE',
      expiresInSec: 272,
    })
    setLeft(272)
    setInputError('')
    void Taro.showToast({ title: '已生成新交易码', icon: 'none' })
  }

  /**
   * 手动输入 6 格。
   *
   * 支持整串粘贴：输入框 maxlength=6，一次粘进来的多位会在 `onInput` 里逐格分配，
   * 与设计稿「6 个独立格子」的观感一致，又不必依赖六个真实输入框。
   */
  const onDigitsInput = (raw: string) => {
    const clean = raw.replace(/\D/g, '').slice(0, 6)
    const next = ['', '', '', '', '', '']
    clean.split('').forEach((ch, i) => {
      next[i] = ch
    })
    setDigits(next)
    setInputError('')
  }

  const joined = digits.join('')
  const canSubmit = joined.length === 6 && !submitting

  /** 确认：本地校验码，重复提交由 submitting 锁住 */
  const submit = () => {
    if (!canSubmit || !code) return
    setSubmitting(true)
    setInputError('')
    setTimeout(() => {
      setSubmitting(false)
      if (joined === code.code) {
        setFlash('交易码正确，确认接口待接入')
        void Taro.showToast({ title: '交易码正确', icon: 'none' })
      } else {
        setInputError('交易码错误，请核对后重新输入。请确认对方展示的是本单的交易码。')
      }
    }, 700)
  }

  const statusPill = done
    ? { label: '已完成', cls: 'is-done' }
    : { label: '待面交', cls: 'is-pending' }

  return (
    <View className="meetup">
      <View className="meetup__bg" />

      <NavBar />

      <View className="meetup__head">
        <View className="meetup__headline">
          <Text className="meetup__title">交易码</Text>
          <Text className={`meetup__st ${statusPill.cls}`}>{statusPill.label}</Text>
        </View>

        {listing && transaction ? (
          <View className="meetup__deal">
            <View className="meetup__deal-thumb">
              <Image className="meetup__deal-img" src={listing.coverUrl} mode="aspectFill" />
            </View>
            <View className="meetup__deal-info">
              <Text className="meetup__deal-title">{listing.title}</Text>
              <Text className="meetup__deal-sub num">
                {`${transaction.role === 'buyer' ? '卖家' : '买家'} ${
                  counterpart?.nickname ?? ''
                } · 订单创建 ${transaction.timeLabel}`}
              </Text>
            </View>
            <Text className="meetup__deal-amount num">
              ¥{formatAmount(transaction.amountCents)}
            </Text>
          </View>
        ) : null}
      </View>

      {/* ---------- 非参与者 / 找不到交易：只有一张说明卡 ---------- */}
      {notParticipant ? (
        <View className="meetup__varcard">
          <View className="meetup__vdisc meetup__vdisc--danger">
            <Image className="meetup__vdisc-ic" src={ICONS.warnInk} mode="aspectFit" />
          </View>
          <Text className="meetup__varcard-title">你不是本次交易的参与者</Text>
          <Text className="meetup__varcard-text">
            交易码仅本单的买家与卖家本人可查看或输入，请从自己的「我的订单」进入本单。
          </Text>
          <View className="meetup__varcard-acts">
            <View className="meetup__btn meetup__btn--sec" onClick={goOrders}>
              <Text>返回我的订单</Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* ---------- 已完成：成功态 ---------- */}
      {!notParticipant && done ? (
        <>
          <View className="meetup__success">
            <View className="meetup__suc-disc">
              <Image className="meetup__suc-ic" src={ICONS.checkCircleWhite} mode="aspectFit" />
            </View>
            <Text className="meetup__suc-title">交易已完成</Text>
            <Text className="meetup__suc-text">
              本次面交已确认，本单已归档。感谢你在校园里完成当面交易。
            </Text>
          </View>

          {listing ? (
            <View className="meetup__sumcard">
              <View className="meetup__sum-thumb">
                <Image className="meetup__sum-img" src={listing.coverUrl} mode="aspectFill" />
              </View>
              <View className="meetup__sum-info">
                <Text className="meetup__sum-title">{listing.title}</Text>
                <Text className="meetup__sum-sub num">
                  {`与 ${counterpart?.nickname ?? ''} · 已完成面交`}
                </Text>
              </View>
              <Text className="meetup__sum-amount num">
                ¥{formatAmount(transaction?.amountCents ?? 0)}
              </Text>
            </View>
          ) : null}

          <Text className="meetup__dead num">
            本单交易码 <Text className="meetup__dead-code">{code?.code ?? ''}</Text> 已失效
          </Text>

          <View className="meetup__bar">
            <View className="meetup__bar-btn meetup__btn--sec" onClick={openConversation}>
              <Image className="meetup__bar-ic" src={ICONS.chatInk} mode="aspectFit" />
              <Text>查看会话</Text>
            </View>
            <View className="meetup__bar-btn meetup__btn--main" onClick={goOrders}>
              <Text>查看订单</Text>
            </View>
          </View>
        </>
      ) : null}

      {/* ---------- 待面交 / 已过期：交易码 + 手动输入 ---------- */}
      {!notParticipant && !done ? (
        <>
          <View className="meetup__sec">
            <Text className="meetup__sec-title">我的交易码</Text>
            <View className="meetup__refresh" onClick={rotate}>
              <Image className="meetup__refresh-ic" src={ICONS.refresh} mode="aspectFit" />
              <Text>刷新</Text>
            </View>
          </View>

          {expired ? (
            <View className="meetup__varcard">
              <View className="meetup__vdisc meetup__vdisc--warn">
                <Image className="meetup__vdisc-ic" src={ICONS.warn} mode="aspectFit" />
              </View>
              <Text className="meetup__varcard-title">交易码已过期</Text>
              <Text className="meetup__varcard-text">
                为保障安全，交易码 5 分钟内有效。点「刷新」生成新的 6 位码，旧码同时作废。
              </Text>
              <View className="meetup__varcard-acts">
                <View className="meetup__btn meetup__btn--pri" onClick={rotate}>
                  <Text>刷新交易码</Text>
                </View>
              </View>
            </View>
          ) : (
            <>
              <View className="meetup__codecard">
                <View className="meetup__digits">
                  {(code?.code ?? '------').split('').map((ch, i) => (
                    <Text key={`d-${i}`} className="meetup__digit num">
                      {ch}
                    </Text>
                  ))}
                </View>
                <Text className="meetup__code-ttl num">
                  有效剩余 <Text className="meetup__code-left">{clockText(left)}</Text> ·
                  面交完成后自动失效
                </Text>

                <View className="meetup__hair" />

                <View className="meetup__qr">
                  <View className="meetup__qr-box">
                    <Image className="meetup__qr-ic" src={ICONS.qr} mode="aspectFit" />
                  </View>
                  <Text className="meetup__qr-cap">请对方用微信扫码</Text>
                </View>
              </View>

              <View className="meetup__notice">
                <Image className="meetup__notice-ic" src={ICONS.lock} mode="aspectFit" />
                <Text className="meetup__notice-tx">
                  交易码一次性有效，过期请点「刷新」重新生成；请勿截图或转发，仅当面出示。
                </Text>
              </View>
            </>
          )}

          {/* ---- 手动输入对方的交易码 ---- */}
          <View className="meetup__sec">
            <Text className="meetup__sec-title">输入对方的交易码</Text>
            <Text className="meetup__sec-note num">6 位数字</Text>
          </View>
          <Text className="meetup__hint">
            请对方在 TA 的「交易码」页面刷新后，把 6 位数字读给你。
          </Text>

          {/*
            六个格子视觉上是独立的，但只挂一个透明输入框：
            六个真实 Input 在小程序里会各自弹键盘、光标乱跳，且整串粘贴无法分配。
            这里用一个覆盖整行、字号透明的 Input 承接输入与粘贴，下面画格子。
          */}
          <View className="meetup__cells">
            {digits.map((ch, i) => (
              <View
                key={`c-${i}`}
                className={`meetup__cell${ch ? ' is-filled' : ''}${
                  inputError ? ' is-bad' : ''
                }${i === joined.length && !inputError ? ' is-focus' : ''}`}
              >
                <Text className="meetup__cell-tx num">{ch}</Text>
              </View>
            ))}
            <Input
              className="meetup__cells-input"
              type="number"
              maxlength={6}
              value={joined}
              onInput={(event) => onDigitsInput(event.detail.value)}
            />
          </View>

          {inputError ? (
            <View className="meetup__errbox">
              <Image className="meetup__err-ic" src={ICONS.warn} mode="aspectFit" />
              <Text className="meetup__err-tx">{inputError}</Text>
            </View>
          ) : null}

          {flash ? <Text className="meetup__flash">{flash}</Text> : null}

          <View className="meetup__bar">
            <View
              className={`meetup__bar-btn meetup__btn--main${canSubmit ? '' : ' is-off'}`}
              onClick={submit}
            >
              {submitting ? <View className="meetup__spin" /> : null}
              <Text>{submitting ? '确认中…' : '确认'}</Text>
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}
