import { Image, Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { readNavMetrics } from '@/lib/nav-metrics'
import { parseLoginLaunch } from './view'
import './index.scss'

/**
 * 扫码登录确认页（#197）—— 电脑端「扫小程序码登录」链路里的小程序侧确认步。
 *
 * 电脑端出码 → 用户用微信扫码拉起本页（或页内扫码后带 `ticket` 进入）→
 * 展示**当前登录账号**的头像与昵称 → 用户明确确认 / 取消 → 服务端把票据
 * 绑定到该账号，电脑端凭 verifier 兑换会话。
 *
 * **当前交付边界（刻意不伪装完成）**：#197 的四个端点与 access_token 基建
 * 尚未合入，确认动作在真实构建下只给「尚未开放」反馈，不假装登录成功；
 * 演示构建（`TARO_APP_MOCK=1` 的显式演示模式，`DEMO_AUTH_ENABLED`）走一段
 * 模拟确认，且未带票号时自动补一枚演示票，让页面在开发者工具里可以
 * 直接演示完整交互（真实构建不受影响）。
 *
 * 其它约定：
 * - 未登录由 `useAuthGuard` 重定向登录页；`unknown`（冷启动身份未恢复）只渲染
 *   占位，不把「还不知道」当「没登录」。
 * - 页面身份：这是**确认页**，头像昵称只读当前会话用户，不接任何「要登录的
 *   电脑端」信息 —— 票据绑定前的设备信息契约不存在，不编造展示。
 * - `ticket` 解析是纯逻辑（`view.ts`，有单测）；取不到票号落「无效登录码」态。
 * - **已知断点（归 #197 接端点时处理）**：未登录进入时守卫用 `redirectTo` 换到
 *   登录页、登录成功后回首页，票据不会自动续上 —— 「登录后回到确认页」需要
 *   把 ticket 带过登录链或调整返回路径，不在本页壳内解决。
 */

type Phase = 'invalid' | 'ready' | 'confirming' | 'success'

/** 演示确认的模拟耗时：给「确认中」状态一个可感知的停留 */
const DEMO_CONFIRM_DELAY_MS = 800

export default function LoginConfirm() {
  useAuthGuard()
  const { status, user } = useAuth()
  const router = useRouter<{ ticket?: string; scene?: string }>()

  // 启动参数在页面生命周期内不变，解析一次即可。
  // 演示构建（显式 TARO_APP_MOCK=1）没有电脑端真的出码：没带票号就补一枚演示票，
  // 页面可以直接完整演示；真实构建仍按参数判定，取不到票号落「无效登录码」。
  const launch = useMemo(
    () => parseLoginLaunch(router.params) ?? (DEMO_AUTH_ENABLED ? { ticket: 'demo-ticket' } : null),
    [router.params],
  )
  const [phase, setPhase] = useState<Phase>(launch ? 'ready' : 'invalid')
  const demoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // NavBar 是绝对定位的漂浮层，内容用它占用的整条高度避让（设备 px，内联下发）；
  // 原生度量不随渲染变化，与既有页面一致 memo 一次
  const nav = useMemo(() => readNavMetrics(), [])

  useEffect(
    () => () => {
      // 卸载作废模拟确认：迟到的 success 不得写回已销毁页面
      if (demoTimerRef.current) clearTimeout(demoTimerRef.current)
    },
    [],
  )

  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) void Taro.navigateBack()
    else void Taro.switchTab({ url: '/pages/home/index' })
  }

  const startConfirm = () => {
    if (phase !== 'ready') return
    if (!DEMO_AUTH_ENABLED) {
      // 真实构建：#197 的 confirm 端点未合入，如实告知，不伪装成功
      void Taro.showToast({ title: '扫码登录服务尚未开放', icon: 'none' })
      return
    }
    setPhase('confirming')
    demoTimerRef.current = setTimeout(() => {
      demoTimerRef.current = null
      setPhase('success')
    }, DEMO_CONFIRM_DELAY_MS)
  }

  const body = (() => {
    if (status === 'unknown') {
      return (
        <View className="lc__stage">
          <Text className="lc__waiting">正在确认身份…</Text>
        </View>
      )
    }
    if (phase === 'invalid') {
      return (
        <View className="lc__stage">
          <View className="lc__disc">
            <Image className="lc__disc-ic" src={ICONS.info} mode="aspectFit" />
          </View>
          <Text className="lc__headline">无效的登录码</Text>
          <Text className="lc__sub">请用电脑端「扫码登录」生成的二维码进入小程序。</Text>
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
