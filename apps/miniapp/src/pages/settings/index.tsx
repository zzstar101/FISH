import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { clearLocalSession, revokeServerSession, useAuth } from '@/features/auth/store'
import { APP_BUILD, APP_VERSION, settings, themeOptions } from '@/mock/api'
import type { ThemeMode } from '@/mock/types'
import './index.scss'

/**
 * B4 设置中心（设计稿 `设计稿_B4-settings.html`）。
 *
 * 分组白卡：账号 / 通用 / 隐私 / 关于，最后是**单独一张卡**的退出登录
 * ——交付要求「危险操作与普通项视觉上必须分开」，所以它不放进任何分组。
 *
 * 主题模式做成可展开的选项列表（设计稿第 02 帧），其余开关即时切换。
 * 偏好项落本地（`Taro.setStorageSync`，`BLOCKED: #66`），不写后端；
 * 也不把各 Domain 的业务逻辑搬进来，这里只管偏好项。
 *
 * **账号信息与退出登录是真实登录态**：账号行读 `features/auth/store` 的当前用户，
 * 退出走 `POST /auth/logout` 并清本地会话（原先两处都是占位）。
 */

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
  const initial = settings()
  const [theme, setTheme] = useState<ThemeMode>(initial.theme)
  const [themeOpen, setThemeOpen] = useState(false)
  const [notifyChat, setNotifyChat] = useState(initial.notifyChat)
  const [notifyWish, setNotifyWish] = useState(initial.notifyWish)
  const [notifyDeal, setNotifyDeal] = useState(initial.notifyDeal)
  const [notifyNews, setNotifyNews] = useState(initial.notifyNews)
  const [publicCampus, setPublicCampus] = useState(initial.publicCampus)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const themeLabel = themeOptions.find((item) => item.key === theme)?.label ?? '跟随系统'

  /** 偏好项落本地存储（真实实现再同步后端） */
  const persist = (patch: Record<string, unknown>) => {
    try {
      const current = Taro.getStorageSync('fish:settings') as Record<string, unknown> | ''
      const base = current && typeof current === 'object' ? current : {}
      Taro.setStorageSync('fish:settings', { ...base, ...patch })
    } catch {
      // 存储失败不影响页面交互，静默即可
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

  return (
    <View className="st">
      <View className="st__bg" />

      <NavBar />

      <View className="st__head">
        <Text className="st__title">设置</Text>
        <Text className="st__meta">账号 · 通用 · 隐私 · 关于</Text>
      </View>

      <View className="st__content">
        {/* ============================ 账号 ============================ */}
        <Text className="st__grouplabel">账号</Text>
        <View className="st__group">
          <View className="st__acct" onClick={() => toast('编辑资料待接入')}>
            <View className="st__av">
              <Text className="st__av-tx">{nickname.slice(0, 1)}</Text>
              {verified ? (
                <Image className="st__av-bdg" src={ICONS.verifiedAccent} mode="aspectFit" />
              ) : null}
            </View>
            <View className="st__acct-main">
              <Text className="st__acct-name">{nickname}</Text>
              <Text className="st__rvalue">{verified ? '已认证' : '未认证'}</Text>
            </View>
            <Text className="st__rvalue">编辑资料</Text>
            <View className="st__arrow" />
          </View>

          <View
            className="st__row"
            onClick={() => void Taro.navigateTo({ url: '/pages/verify/index' })}
          >
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.safeAccent} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">校园认证</Text>
            <Text className="st__rvalue">{verified ? '已认证' : '去认证'}</Text>
            <View className="st__arrow" />
          </View>
        </View>

        {/* ============================ 通用 ============================ */}
        <Text className="st__grouplabel">通用</Text>
        <View className="st__group">
          <View className="st__row" onClick={() => setThemeOpen((prev) => !prev)}>
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.moon} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">主题模式</Text>
            <Text className="st__rvalue">{themeLabel}</Text>
            <View className={`st__arrow${themeOpen ? ' is-open' : ''}`} />
          </View>

          {themeOpen ? (
            <View className="st__opts">
              {themeOptions.map((item) => (
                <View
                  key={item.key}
                  className={`st__opt${item.key === theme ? ' is-on' : ''}`}
                  onClick={() => {
                    setTheme(item.key)
                    persist({ theme: item.key })
                  }}
                >
                  <View className="st__opt-main">
                    <Text className="st__rlabel">{item.label}</Text>
                    <Text className="st__odesc">{item.desc}</Text>
                  </View>
                  <View className={`st__radio${item.key === theme ? ' is-on' : ''}`} />
                </View>
              ))}
            </View>
          ) : null}

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
          {[
            {
              key: 'chat',
              label: '新消息',
              value: notifyChat,
              set: setNotifyChat,
              icon: ICONS.chatInk,
            },
            {
              key: 'wish',
              label: '许愿命中',
              value: notifyWish,
              set: setNotifyWish,
              icon: ICONS.heartOn,
            },
            {
              key: 'deal',
              label: '交易提醒',
              value: notifyDeal,
              set: setNotifyDeal,
              icon: ICONS.orderMuted,
            },
            {
              key: 'news',
              label: '活动与公告',
              value: notifyNews,
              set: setNotifyNews,
              icon: ICONS.feedback,
            },
          ].map((item) => (
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
                itemList: ['已认证用户', '所有人', '仅好友'],
                success: (res) => {
                  const policy = ['已认证用户', '所有人', '仅好友'][res.tapIndex] ?? '已认证用户'
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
            <Text className="st__rvalue">{initial.commentPolicy}</Text>
            <View className="st__arrow" />
          </View>

          <View className="st__row">
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.locationPin} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">公开我的校区</Text>
            <View
              className={`st__sw${publicCampus ? ' is-on' : ''}`}
              onClick={() => {
                setPublicCampus((prev) => !prev)
                persist({ publicCampus: !publicCampus })
              }}
            >
              <View className="st__sw-knob" />
            </View>
          </View>
        </View>

        {/* ============================ 关于 ============================ */}
        <Text className="st__grouplabel">关于</Text>
        <View className="st__group">
          <View className="st__row" onClick={() => toast('意见反馈待接入')}>
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.feedback} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">意见反馈</Text>
            <View className="st__arrow" />
          </View>

          <View className="st__row" onClick={() => toast(`鱼小应 v${APP_VERSION}`)}>
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.app} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">关于鱼小应</Text>
            <Text className="st__rvalue num">{`v${APP_VERSION}`}</Text>
            <View className="st__arrow" />
          </View>

          <View className="st__row" onClick={() => toast('用户协议待接入')}>
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.docInk} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">用户协议</Text>
            <View className="st__arrow" />
          </View>

          <View className="st__row" onClick={() => toast('隐私政策待接入')}>
            <View className="st__ric">
              <Image className="st__ric-ic" src={ICONS.docInk} mode="aspectFit" />
            </View>
            <Text className="st__rlabel">隐私政策</Text>
            <View className="st__arrow" />
          </View>
        </View>

        {/* ==================== 危险操作：单独一张卡 ==================== */}
        <View className="st__danger-card">
          <View className="st__danger-row" onClick={() => setLogoutOpen(true)}>
            <Image className="st__danger-ic" src={ICONS.power} mode="aspectFit" />
            <Text>退出登录</Text>
          </View>
        </View>
        <Text className="st__danger-note">退出后需重新登录，本地草稿与收藏记录不会丢失。</Text>
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
