import { Image, Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import { confirmScanTicket } from '@/features/auth/api'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError } from '@/lib/request'
import { classifyConfirmFailure, resolveLoginLaunch } from './view'
import './index.scss'

/**
 * 扫码登录确认页（#197）—— 电脑端「扫小程序码登录」链路里的小程序侧确认步。
 *
 * 电脑端出码 → 用户用微信扫码拉起本页（或页内扫码后带 `ticket` 进入）→
 * 展示**当前登录账号**的头像与昵称 → 用户明确确认 / 取消 → 服务端把票据
 * 绑定到该账号，电脑端凭 verifier 兑换会话。
 *
 * 确认动作（#197 端点已合入）：`POST /auth/wechat/scan/ticket/:ticket/confirm`
 * （契约 `packages/contracts/src/auth/scan.ts`）。204 → 成功；404 `SCAN_TICKET_INVALID`
 * → 「无效登录码」面板；409 `SCAN_TICKET_CONFLICT` → 「已被占用」面板；其余失败退回
 * 确认态给 toast（401 会话失效由请求层清会话，守卫随后带票跳登录续接）。
 * 演示构建（`TARO_APP_MOCK=1` 的显式演示模式，`DEMO_AUTH_ENABLED`）不走网络，仍用一段
 * 模拟确认，并在**入口什么都没给**时补一枚形状合法的演示票，让页面在开发者工具里
 * 可以直接演示完整交互（真实构建不受影响；带了非法票号仍落「无效登录码」）。
 *
 * 其它约定：
 * - 未登录由 `useAuthGuard` 重定向登录页，**带 `back` + `ticket`**：登录成功后原路
 *   回到本页把票据续上（登录页按 `back` 参数分支跳转，见 `pages/login/index.tsx`）。
 *   `unknown`（冷启动身份未恢复）只渲染占位，不把「还不知道」当「没登录」。
 * - 页面身份：这是**确认页**，头像昵称只读当前会话用户，不接任何「要登录的
 *   电脑端」信息 —— 票据绑定前的设备信息契约不存在，不编造展示。
 * - 票据解析与合法性判定是纯逻辑（`view.ts`，有单测，直接用契约 `ScanTicketSchema`）；
 *   取不到合法票号落「无效登录码」态。
 */

type Phase = 'invalid' | 'conflict' | 'ready' | 'confirming' | 'success'

/** 演示确认的模拟耗时：给「确认中」状态一个可感知的停留 */
const DEMO_CONFIRM_DELAY_MS = 800

export default function LoginConfirm() {
  const { status, user } = useAuth()
  const router = useRouter<{ ticket?: string; scene?: string }>()

  // 启动参数在页面生命周期内不变，解析一次即可。演示构建的补票（只在入口什么都没给时）
  // 与真实票据走同一套形状校验，见 `view.ts` 的 `resolveLoginLaunch`。
  const launch = useMemo(
    () => resolveLoginLaunch(router.params, DEMO_AUTH_ENABLED),
    [router.params],
  )
  const [phase, setPhase] = useState<Phase>(launch ? 'ready' : 'invalid')
  const demoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 卸载作废在途确认：迟到的 success / 失败分类不得写回已销毁页面（与演示计时器同一纪律）
  const aliveRef = useRef(true)
  useEffect(
    () => () => {
      aliveRef.current = false
      // 卸载作废模拟确认：迟到的 success 不得写回已销毁页面
      if (demoTimerRef.current) clearTimeout(demoTimerRef.current)
    },
    [],
  )

  // 未登录跳登录页时把票据带上：登录成功后原路回本页（`back` 参数分支见登录页）。
  // 票据本身印在二维码里就是公开的，放进页内跳转参数不扩大暴露面。
  const loginUrl = useMemo(
    () =>
      launch
        ? `/pkg-auth/pages/login/index?back=${encodeURIComponent('pkg-auth/pages/login-confirm/index')}&ticket=${encodeURIComponent(launch.ticket)}`
        : undefined,
    [launch],
  )
  useAuthGuard(loginUrl ? { loginUrl } : {})

  // NavBar 是绝对定位的漂浮层，内容用它占用的整条高度避让（设备 px，内联下发）；
  // 原生度量不随渲染变化，与既有页面一致 memo 一次
  const nav = useMemo(() => readNavMetrics(), [])

  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) void Taro.navigateBack()
    else void Taro.switchTab({ url: '/pages/home/index' })
  }

  const startConfirm = () => {
    if (phase !== 'ready' || !launch) return
    setPhase('confirming')
    if (DEMO_AUTH_ENABLED) {
      // 演示构建：不走网络（演示构建的目的就是每页可离线演示），模拟确认耗时
      demoTimerRef.current = setTimeout(() => {
        demoTimerRef.current = null
        setPhase('success')
      }, DEMO_CONFIRM_DELAY_MS)
      return
    }
    void (async () => {
      try {
        await confirmScanTicket(launch.ticket)
        if (!aliveRef.current) return
        setPhase('success')
      } catch (error) {
        if (!aliveRef.current) return
        const failure = classifyConfirmFailure(isApiError(error) ? { code: error.code } : null)
        if (failure === 'retry') {
          // 网络/服务端抖动：退回确认态让人再试一次，不把抖动伪装成票据问题
          setPhase('ready')
          void Taro.showToast({ title: '确认失败，请稍后重试', icon: 'none' })
          return
        }
        setPhase(failure)
      }
    })()
  }

  const body = (() => {
    if (status === 'unknown') {
      return (
        <View className="lc__stage">
          <Text className="lc__waiting">正在确认身份…</Text>
        </View>
      )
    }
    if (phase === 'invalid' || phase === 'conflict') {
      return (
        <View className="lc__stage">
          <View className="lc__disc">
            <Image className="lc__disc-ic" src={ICONS.info} mode="aspectFit" />
          </View>
          <Text className="lc__headline">
            {phase === 'conflict' ? '登录码已被占用' : '无效的登录码'}
          </Text>
          <Text className="lc__sub">
            {phase === 'conflict'
              ? '这张登录码已被另一个账号确认。请在电脑端重新生成二维码。'
              : '请用电脑端「扫码登录」生成的二维码进入小程序。'}
          </Text>
          <View className="lc__btn-ghost" onClick={goBack}>
            <Text>返回</Text>
          </View>
        </View>
      )
    }
    if (phase === 'success') {
      return (
        <View className="lc__stage">
          <View className="lc__disc lc__disc--ok">
            <Image className="lc__disc-ic" src={ICONS.checkCircle} mode="aspectFit" />
          </View>
          <Text className="lc__headline">已在电脑端登录</Text>
          <Text className="lc__sub">本次登录确认已完成，回到电脑端即可继续使用。</Text>
          <View className="lc__btn-main lc__btn-main--inline" onClick={goBack}>
            <Text>完成</Text>
          </View>
        </View>
      )
    }
    return (
      <>
        <View className="lc__stage">
          <View className="lc__avatar">
            {/* 契约 `MeSchema.avatarUrl` 可为 null：空就画人形占位，不拿别人的头像顶上 */}
            {user?.avatarUrl ? (
              <Image className="lc__avatar-img" src={user.avatarUrl} mode="aspectFill" />
            ) : (
              <Image className="lc__avatar-ph" src={ICONS.user} mode="aspectFit" />
            )}
          </View>
          <Text className="lc__name">{user?.nickname ?? '—'}</Text>
          <Text className="lc__headline">确认登录此电脑端</Text>
          <Text className="lc__sub">确认后，该电脑端将以你的身份登录鱼小应。</Text>
        </View>
        <View className="lc__acts">
          <View
            className={`lc__btn-main${phase === 'confirming' ? ' is-off' : ''}`}
            onClick={startConfirm}
          >
            <Text>{phase === 'confirming' ? '确认中…' : '确认登录'}</Text>
          </View>
          <View className="lc__btn-ghost" onClick={goBack}>
            <Text>取消</Text>
          </View>
        </View>
      </>
    )
  })()

  return (
    <View className="lc">
      <View className="lc__bg" />
      <NavBar title="扫码登录" titleAlign="center" />
      <View className="lc__inner" style={{ paddingTop: `${nav.totalHeight + 24}px` }}>
        {body}
      </View>
    </View>
  )
}
