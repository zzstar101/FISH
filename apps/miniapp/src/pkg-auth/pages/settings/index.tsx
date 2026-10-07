import { ACCOUNT_DELETION_COOLING_OFF_DAYS } from '@fish/contracts/account-deletion/schema'
import { Image, Text, View } from '@tarojs/components'
import Taro, { usePageScroll } from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { clearLocalSession, revokeServerSession, useAuth } from '@/features/auth/store'
import type { NotifyKey } from '@/features/settings/preferences'
import {
  COMMENT_POLICIES,
  NOTIFY_KEYS,
  parseStoredPrefs,
  readStoredPrefs,
  SETTINGS_STORAGE_KEY,
} from '@/features/settings/preferences'
import { NOTIFY_PREFS_EVENT } from '@/features/settings/unread-badge'
import { APP_BUILD, APP_VERSION } from '@/lib/app-meta'
import { settings } from '@/lib/settings-defaults'
import type { MockSettings } from '@/mock/types'
import './index.scss'

/**
 * B4 设置中心（设计稿 `设计稿_B4-settings.html`）。
 *
 * 分组白卡：账号 / 通用 / 隐私 / 关于，最后是**单独一张卡**的退出登录
 * ——交付要求「危险操作与普通项视觉上必须分开」，所以它不放进任何分组。
 *
 * 通知开关即时切换并**接了真实消费方**：底栏「消息」徽标按这些开关过滤对应分量
 * （`custom-tab-bar` 经 `features/settings/unread-badge` 的闸门读同一份白名单），开关
 * 一变就广播 `NOTIFY_PREFS_EVENT` 让常驻的底栏实例重算。偏好项落本地并在挂载时读回
 * （`Taro.setStorageSync` / `getStorageSync`，`BLOCKED: #66`），不写后端；也不把各
 * Domain 的业务逻辑搬进来，这里只管偏好项。
 *
 * **主题三档已整组撤掉**（2026-10-05 Owner 拍板）：它从未有过消费方 —— 暗色主题
 * 没实现，全仓没有任何样式读这个偏好，开关等于骗人；需求单另行跟踪，做实后再回来。
 *
 * **账号信息与退出登录是真实登录态**：账号行读 `features/auth/store` 的当前用户，
 * 退出走 `POST /auth/logout` 并清本地会话（原先两处都是占位）。
 */

/** `getStorageSync` 只能在端上跑；读取失败（低版本禁用存储等）视为「没存过」 */
const readStorage = (): unknown => {
  try {
    return Taro.getStorageSync(SETTINGS_STORAGE_KEY)
  } catch {
    return null
  }
}

/** 通知明细行配置：`key` 就是存储键（`NotifyKey` 对 `MockSettings` 的 notify* 字段锁定） */
type NotifyRow = {
  key: NotifyKey
  label: string
  value: boolean
  set: (value: boolean) => void
  icon: string
}

export default function Settings() {
  // 设置页展示的是账号信息，未登录不该停留在这里（守卫只管跳转，页面继续渲染）
  useAuthGuard()
  const { user } = useAuth()
  /**
   * 账号行只用**真实登录用户**。
   *
   * `GET /me` 还没回来时不拿 mock 顶上 —— 那会把演示账号「阿岚」显示给一个真实登录用户。
   * 此时用占位符，等 store 广播 `authed` 后再渲染真实昵称。
   */
  const nickname = user?.nickname ?? '—'
  const verified = user?.authStatus === 'VERIFIED'
  // 偏好初始值 = 默认值 + 本机存量（盖回去，重进页面不再重置）；
  // 只在页面实例首次挂载时读一次存储，之后的改动都走 state + persist。
  const [initial] = useState(() => parseStoredPrefs(readStorage(), settings()))
  const [notifyChat, setNotifyChat] = useState(initial.notifyChat)
  const [notifyWish, setNotifyWish] = useState(initial.notifyWish)
  const [notifyDeal, setNotifyDeal] = useState(initial.notifyDeal)
  const [notifyNews, setNotifyNews] = useState(initial.notifyNews)
  const [commentPolicy, setCommentPolicy] = useState(initial.commentPolicy)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  /**
   * 顶栏两态（#386 批次 2）：返回键常驻吸顶，滚过阈值后玻璃底 + 标题「设置」浮现
   * （在返回键隔壁，Owner 2026-10-01 拍板「就像商品详情页一样」）。
   * 阈值取 40 设备 px，与 `pages/user` 的 `GLASS_AT` 同值 —— 都在页头大标题滚进
   * 导航行前后触发，不到一屏就想露出玻璃底会让它常亮、失去「浮现」的语义。
   */
  const REVEAL_AT = 40
  const [revealed, setRevealed] = useState(false)
  usePageScroll(({ scrollTop }) => setRevealed(scrollTop > REVEAL_AT))

  /** 偏好项落本地存储（真实实现再同步后端）；存量要并回来，别把别的键冲掉 */
  const persist = (patch: Partial<MockSettings>) => {
    try {
      const base = readStoredPrefs(Taro.getStorageSync(SETTINGS_STORAGE_KEY))
      Taro.setStorageSync(SETTINGS_STORAGE_KEY, { ...base, ...patch })
    } catch {
      // 存储失败不影响页面交互，静默即可
    }
    // 通知开关变了就广播：底栏实例常驻每个 Tab 页，不会因为本页的 state 重渲染，
    // 只有显式广播才能让它立刻按新偏好重算红点（同 `lib/tabbar-sync` 的模式）
    if (NOTIFY_KEYS.some((key) => key in patch)) {
      Taro.eventCenter.trigger(NOTIFY_PREFS_EVENT)
    }
  }

  const toast = (title: string) => void Taro.showToast({ title, icon: 'none' })

  const onLogout = () => {
    if (loggingOut) return
    setLoggingOut(true)
    void (async () => {
      // 分两步：先注销服务端会话并把必要的告知走完，再本地登出。
      // 本地登出会广播 `anonymous`，守卫随即把本页跳去登录页 ——
      // 若把提示写在登出之后，弹窗会落在正在卸载的页面上（弱网下等于不提示）。
      const serverRevoked = await revokeServerSession()
      setLoggingOut(false)
      setLogoutOpen(false)
      if (!serverRevoked) {
        await Taro.showModal({
          title: '已在本机退出',
          content: '服务器没有响应，登录会话可能仍然有效。联网后建议再退出一次。',
          showCancel: false,
          confirmText: '知道了',
        })
      }
      // 到这里才真正登出：守卫负责跳登录页，页面自己不再跳
      clearLocalSession()
    })()
  }

  /** key 即存储键（NotifyKey），persist 与读回白名单同源 —— 写 'chat' 这类错键就是从这来的 */
  const notifyRows: NotifyRow[] = [
    {
      key: 'notifyChat',
      label: '新消息',
      value: notifyChat,
      set: setNotifyChat,
      icon: ICONS.chatInk,
    },
    {
      key: 'notifyWish',
      label: '许愿命中',
      value: notifyWish,
      set: setNotifyWish,
      icon: ICONS.heartOn,
    },
    {
      key: 'notifyDeal',
      label: '交易提醒',
      value: notifyDeal,
      set: setNotifyDeal,
      icon: ICONS.orderMuted,
    },
    {
      key: 'notifyNews',
      label: '活动与公告',
      value: notifyNews,
      set: setNotifyNews,
      icon: ICONS.feedback,
    },
  ]

  return (
    <View className="st">
      <View className="st__bg" />

      <NavBar fixed glass={revealed} title={revealed ? '设置' : undefined} />

      <View className="st__head">
        <Text className="st__title">设置</Text>
        <Text className="st__meta">账号 · 通用 · 隐私 · 关于</Text>
      </View>

      <View className="st__content">
        {/* ============================ 账号 ============================ */}
        <Text className="st__grouplabel">账号</Text>
        <View className="st__group">
          <View
            className="st__acct"
            onClick={() => void Taro.navigateTo({ url: '/pkg-auth/pages/profile-edit/index' })}
          >
            <View className="st__av">
              <Text className="st__av-tx">{nickname.slice(0, 1)}</Text>
              {verified ? (
                <Image className="st__av-bdg" src={ICONS.verifiedAccent} mode="aspectFit" />
              ) : null}
            </View>
            <View className="st__acct-main">
              <Text className="st__acct-name">{nickname}</Text>
              <Text className="st__rvalue">{verified ? '已验证' : '未验证'}</Text>
            </View>
            <Text className="st__rvalue">编辑资料</Text>
            <View className="st__arrow" />
          </View>

          <View
            className="st__row"
            onClick={() => void Taro.navigateTo({ url: '/pkg-auth/pages/verify/index' })}
          >
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.safeAccent} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">教育邮箱</Text>
            <Text className="st__rvalue">{verified ? '已验证' : '去验证'}</Text>
            <View className="st__arrow" />
          </View>
        </View>

        {/* ============================ 通用 ============================ */}
        <Text className="st__grouplabel">通用</Text>
        <View className="st__group">
          <View className="st__row">
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.bellInk} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">通知设置</Text>
            <View
              className={`st__sw${notifyChat || notifyWish || notifyDeal ? ' is-on' : ''}`}
              onClick={() => {
                const next = !(notifyChat || notifyWish || notifyDeal)
                setNotifyChat(next)
                setNotifyWish(next)
                setNotifyDeal(next)
                persist({ notifyChat: next, notifyWish: next, notifyDeal: next })
              }}
            >
              <View className="st__sw-knob" />
            </View>
          </View>
        </View>

        {/* ---- 通知明细（展开后才出现，对应设计稿第 02 帧） ---- */}
        <View className="st__grouplabel">通知设置</View>
        <View className="st__group">
          {notifyRows.map((item) => (
            <View key={item.key} className="st__row">
              <View className="st__ric">
                <Image className="st__ric-ic" src={item.icon} mode="aspectFit" />
              </View>
              <Text className="st__rlabel">{item.label}</Text>
              <View
                className={`st__sw${item.value ? ' is-on' : ''}`}
                onClick={() => {
                  item.set(!item.value)
                  persist({ [item.key]: !item.value })
                }}
              >
                <View className="st__sw-knob" />
              </View>
            </View>
          ))}
        </View>
        <Text className="st__note">
          关闭系统级通知权限会导致以上开关失效，需到微信「设置 → 新消息通知」中恢复。
        </Text>

        {/* ============================ 隐私 ============================ */}
        <Text className="st__grouplabel">隐私</Text>
        <View className="st__group">
          <View
            className="st__row"
            onClick={() =>
              void Taro.showActionSheet({
                itemList: [...COMMENT_POLICIES],
                success: (res) => {
                  const policy = COMMENT_POLICIES[res.tapIndex] ?? COMMENT_POLICIES[0]
                  setCommentPolicy(policy)
                  persist({ commentPolicy: policy })
                  toast(`已设为「${policy}」`)
                },
              }).catch(() => undefined)
            }
          >
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.chatInk} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">谁可以给我留言</Text>
            <Text className="st__rvalue">{commentPolicy}</Text>
            <View className="st__arrow" />
          </View>

          {/* 黑名单管理（#466 端上批次 / #473）：列出我拉黑的人 + 逐行解除。
              拉黑入口在他人主页；这里只做管理。 */}
          <View
            className="st__row"
            onClick={() => void Taro.navigateTo({ url: '/pkg-auth/pages/blocked/index' })}
          >
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.shieldLine} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">黑名单</Text>
            <View className="st__arrow" />
          </View>
        </View>

        {/* ============================ 关于 ============================ */}
        {/* 四行都接上了真实页面（未定内容页面，实际内容由 zzstar 决策）。
            「关于鱼小应」与「我的 → 关于与版本」是同一个页面的两个入口名 ——
            口径不一致这件事稿里已标出，等 Owner 统一后再改文案，本次不动。 */}
        <Text className="st__grouplabel">关于</Text>
        <View className="st__group">
          <View
            className="st__row"
            onClick={() => void Taro.navigateTo({ url: '/pkg-legal/pages/feedback/index' })}
          >
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.feedback} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">意见反馈</Text>
            <View className="st__arrow" />
          </View>

          <View
            className="st__row"
            onClick={() => void Taro.navigateTo({ url: '/pkg-legal/pages/about/index' })}
          >
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.app} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">关于鱼小应</Text>
            <Text className="st__rvalue num">{`v${APP_VERSION}`}</Text>
            <View className="st__arrow" />
          </View>

          <View
            className="st__row"
            onClick={() => void Taro.navigateTo({ url: '/pkg-legal/pages/terms/index' })}
          >
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.docInk} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">用户协议</Text>
            <View className="st__arrow" />
          </View>

          <View
            className="st__row"
            onClick={() => void Taro.navigateTo({ url: '/pkg-legal/pages/privacy/index' })}
          >
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.docInk} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">隐私政策</Text>
            <View className="st__arrow" />
          </View>
        </View>

        {/* ==================== 危险操作：单独一张卡 ====================
            注销排在退出登录**下面**：两者都会让账号不可用，但注销更重（有 7 天冷静期、
            会下架商品），放在最后一行可以少一点误触。 */}
        <View className="st__danger-card">
          <View className="st__danger-row" onClick={() => setLogoutOpen(true)}>
            <Image className="st__danger-ic" src={ICONS.power} mode="aspectFit" />
            <Text>退出登录</Text>
          </View>
          <View
            className="st__danger-row"
            onClick={() => void Taro.navigateTo({ url: '/pkg-auth/pages/account-deletion/index' })}
          >
            <Image className="st__danger-ic" src={ICONS.delete} mode="aspectFit" />
            <Text>注销账号</Text>
          </View>
        </View>
        <Text className="st__danger-note">
          退出后需重新登录，本地草稿与收藏记录不会丢失。{'\n'}
          注销账号有 {ACCOUNT_DELETION_COOLING_OFF_DAYS} 天冷静期，期间可撤回。
        </Text>
        <Text className="st__version num">{`鱼小应 v${APP_VERSION} · build ${APP_BUILD}`}</Text>
      </View>

      {/* ==================== 退出登录二次确认（吸底弹层） ==================== */}
      {logoutOpen ? (
        <>
          <View className="st__scrim" onClick={() => setLogoutOpen(false)} />
          <View className="st__sheet">
            <View className="st__sheet-ic">
              <Image className="st__sheet-ic-img" src={ICONS.power} mode="aspectFit" />
            </View>
            <Text className="st__sheet-title">确认退出登录？</Text>
            <Text className="st__sheet-text">
              退出后需重新登录才能继续聊一聊、查看订单。{'\n'}本地草稿与收藏记录不会丢失。
            </Text>
            <View className="st__sheet-acts">
              <View className="st__sheet-cancel" onClick={() => setLogoutOpen(false)}>
                <Text>再想想</Text>
              </View>
              <View className={`st__sheet-ok${loggingOut ? ' is-off' : ''}`} onClick={onLogout}>
                {loggingOut ? <View className="st__spin" /> : null}
                <Text>{loggingOut ? '退出中…' : '退出登录'}</Text>
              </View>
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}
