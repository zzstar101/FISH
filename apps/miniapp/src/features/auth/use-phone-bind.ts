import Taro, { useDidHide, useDidShow, useUnload } from '@tarojs/taro'
import { useRef, useState } from 'react'
import { isApiError } from '@/lib/request'
import { sessionEpoch } from '@/lib/session'
import { bindPhone } from './api'
import {
  type PhoneAuthDetail,
  phoneAuthHint,
  phoneBindFailureMessage,
  readPhoneAuthResult,
  runPhoneBind,
} from './phone'
import { applyPhoneBinding, authSnapshot } from './store'

/**
 * 手机号绑定的页面编排（#204 设置页 → #514 抽出，出物页 / 许愿页 / 设置页共用）。
 *
 * 纯判定（授权回调分类、失败文案、会话票据）在 `./phone`，这里只负责把它们接到**页面实例**上：
 * 防连点、页面存活、页面可见性、写 store、提示。必须在**页面组件**里调用（依赖页面生命周期
 * `useDidShow` / `useDidHide` / `useUnload`）。
 */

/**
 * `onGetPhoneNumber` 的事件收窄：Taro 的类型按「成功」声明（`encryptedData` / `iv` 是
 * required），但用户拒绝授权时 detail 只有 `errMsg`、没有 code，所以只声明真正会读的字段
 * （同 `pkg-auth/pages/profile-edit` 里 `ChooseAvatarEvent` 的做法）。
 */
export type PhoneNumberEvent = { detail: PhoneAuthDetail }

export type UsePhoneBindOptions = {
  /**
   * 绑定成功、store 已写入之后调用（页面已卸载 / 会话已变时不调用）。
   * 出物页 / 许愿页用它关掉绑定 sheet。
   */
  onBound?: () => void
  /** 绑定成功的提示文案（只在页面可见时弹），默认「手机号已绑定」 */
  boundToast?: string
}

export type PhoneBind = {
  /** 绑定请求飞行中：按钮画成「绑定中…」并禁用 */
  binding: boolean
  /** 挂到原生 `<Button openType="getPhoneNumber">` 的 `onGetPhoneNumber` 上 */
  onGetPhoneNumber: (event: PhoneNumberEvent) => void
}

export function usePhoneBind(options: UsePhoneBindOptions = {}): PhoneBind {
  /** 读**最新**一次渲染的回调：绑定可能飞行十几秒，闭包里那份可能已经过期 */
  const optionsRef = useRef(options)
  optionsRef.current = options

  const toast = (title: string) => void Taro.showToast({ title, icon: 'none' })

  /**
   * 手机号绑定（#204）的渲染态。
   *
   * `binding` 负责把按钮画成「绑定中…」，`bindingRef` 才是真正的防连点闸门：
   * `setState` 是异步的，同一帧里两次点击都会读到旧的 `binding`，于是同一份 code 被提交
   * 两次 —— 微信 code 一次性，第二次必然 422，用户会看到一个多余的报错。ref 是同步的。
   */
  const [binding, setBinding] = useState(false)
  const bindingRef = useRef(false)
  /**
   * 本页面实例是否还活着。#204 审查 P2：会话代次挡不住「返回设置页 → 再进来 → 新页面绑好 →
   * 旧页面的响应迟到」这一档 —— 同一个账号、同一个会话代次，旧响应的 `{ownerId, epoch}`
   * 与新任务**完全一样**，于是它会覆盖新掩码、再弹一次 toast、解开已作废页面的按钮态。
   * 唯一可靠的作废信号是页面生命周期本身，所以卸载即置 `false`。
   */
  const pageAliveRef = useRef(true)
  /**
   * 本页面实例是否**可见**。#204 审查 C 轮：`useUnload` 只在页面被销毁时跑，用户从这里
   * `navigateTo` 进别的页面时本页只是被隐藏（`onHide`），实例仍然存活 —— 于是绑定的成功 /
   * 失败 toast 会盖在那个无关页面上，看起来像那边操作的结果。所以提示另走一层可见性判断；
   * **store 更新不受影响**（号码确实绑到了这个账号，回来时该看到新掩码）。
   */
  const pageVisibleRef = useRef(true)
  useDidShow(() => {
    pageVisibleRef.current = true
  })
  useDidHide(() => {
    pageVisibleRef.current = false
  })
  useUnload(() => {
    pageAliveRef.current = false
  })

  /**
   * 只在页面**可见**时提示。
   *
   * 绑定请求飞行中用户可能已经进了别的页面（`navigateTo` 只隐藏本页、不销毁），此时的成功 /
   * 失败 toast 会盖在那个无关页面上。store 更新照做（号码确实绑到了这个账号，回来就该看到
   * 新掩码），只有提示按可见性过滤。
   */
  const toastIfVisible = (title: string) => {
    if (pageVisibleRef.current) toast(title)
  }

  /**
   * 手机号授权回调。
   *
   * 只把 `detail.code` 交给后端：`encryptedData` / `iv` / 明文号码既不读也不上报
   * （契约 `packages/contracts/src/auth/phone.ts`）。用户拒绝授权时回调里没有 code，
   * 只带 `errMsg` —— 那时轻提示一句就行，不当成错误（后端一次都没被调用）。
   *
   * 隐私：`open-type="getPhoneNumber"` 本身就是隐私接口，未同意《用户隐私保护指引》时
   * 微信会**自己**弹官方弹窗，所以这里不接自定义 `agreePrivacyAuthorization`
   * （全仓都没有自定义隐私弹窗，见 `@/lib/privacy`；后台需声明隐私保护指引，不声明时平台不拦）。
   */
  const onGetPhoneNumber = (event: PhoneNumberEvent) => {
    const auth = readPhoneAuthResult(event.detail)
    if (auth.kind !== 'code') {
      toast(phoneAuthHint(auth))
      return
    }
    // 没有登录账号就没有「把手机号绑给谁」，不发请求（守卫会把页面跳去登录页）
    const ownerId = authSnapshot().user?.id ?? null
    if (ownerId === null) return
    if (bindingRef.current) return
    bindingRef.current = true
    setBinding(true)
    const ticket = { ownerId, epoch: sessionEpoch() }
    void (async () => {
      try {
        const outcome = await runPhoneBind(
          { ticket, code: auth.code },
          {
            bindPhone,
            // 读**当前**会话（不是发起时那份）：请求飞行途中用户可能已退出 / 换号
            session: () => ({ ownerId: authSnapshot().user?.id ?? null, epoch: sessionEpoch() }),
            // 读**当前**页面存活：返回（页面卸载）后迟到的结果一律作废
            pageAlive: () => pageAliveRef.current,
          },
        )
        // 会话已变 / 页面已卸载：这趟结果不属于任何人，既不写 store 也不提示
        // （例外：把当前会话清掉的 401 会以 `failed` 回来，走下面那条分支告诉用户「登录已失效」）
        if (outcome.kind === 'aborted') return
        if (outcome.kind === 'failed') {
          toastIfVisible(
            phoneBindFailureMessage(
              isApiError(outcome.error)
                ? { code: outcome.error.code, message: outcome.error.message }
                : null,
            ),
          )
          return
        }
        applyPhoneBinding(outcome.ownerId, {
          phoneBound: true,
          maskedPhone: outcome.maskedPhone,
        })
        optionsRef.current.onBound?.()
        toastIfVisible(optionsRef.current.boundToast ?? '手机号已绑定')
      } finally {
        // 页面已卸载就别再动它：新页面实例自己有一份 `binding` / `bindingRef`，往作废实例上写
        // 只会污染一个已经没人看的 state（且 `finally` 是这一段里唯一还会碰到组件状态的地方）
        if (pageAliveRef.current) {
          bindingRef.current = false
          setBinding(false)
        }
      }
    })()
  }

  return { binding, onGetPhoneNumber }
}
