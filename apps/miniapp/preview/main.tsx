/**
 * 预览外壳：按 URL hash 选择页面模块并渲染。
 *
 * hash 形如 `#/pages/listing-detail/index?id=l-001`，与小程序 `navigateTo` 的 url 一致，
 * 所以页面里的 `Taro.navigateTo({ url })` 在预览里也能真的跳转。
 */

import type { ComponentType } from 'react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import CustomTabBar from '@/custom-tab-bar'
import { useRouterState } from './taro-web-stub'
// 全局壳样式（令牌 + .page/.pad/.sec）：与小程序端同一份 app.scss，避免两边样式漂移
import '../src/app.scss'

/** 与 src/app.config.ts 的 pages 一一对应（顺序、数量都必须一致） */
const PAGES: Record<string, () => Promise<{ default: ComponentType }>> = {
  '/pages/home/index': () => import('@/pages/home/index'),
  '/pages/wish/index': () => import('@/pages/wish/index'),
  '/pkg-social/pages/wish-publish/index': () => import('@/pkg-social/pages/wish-publish/index'),
  '/pages/sell/index': () => import('@/pages/sell/index'),
  '/pages/chat/index': () => import('@/pages/chat/index'),
  '/pages/profile/index': () => import('@/pages/profile/index'),
  '/pkg-auth/pages/account-deletion/index': () => import('@/pkg-auth/pages/account-deletion/index'),
  '/pkg-auth/pages/profile-edit/index': () => import('@/pkg-auth/pages/profile-edit/index'),
  '/pkg-browse/pages/search/index': () => import('@/pkg-browse/pages/search/index'),
  '/pkg-browse/pages/listing-detail/index': () => import('@/pkg-browse/pages/listing-detail/index'),
  '/pkg-social/pages/conversation/index': () => import('@/pkg-social/pages/conversation/index'),
  '/pkg-trade/pages/send-listing/index': () => import('@/pkg-trade/pages/send-listing/index'),
  '/pkg-trade/pages/orders-buy/index': () => import('@/pkg-trade/pages/orders-buy/index'),
  '/pkg-trade/pages/orders-sell/index': () => import('@/pkg-trade/pages/orders-sell/index'),
  '/pkg-trade/pages/transaction-meetup/index': () =>
    import('@/pkg-trade/pages/transaction-meetup/index'),
  '/pkg-auth/pages/login/index': () => import('@/pkg-auth/pages/login/index'),
  '/pkg-auth/pages/login-confirm/index': () => import('@/pkg-auth/pages/login-confirm/index'),
  '/pkg-auth/pages/settings/index': () => import('@/pkg-auth/pages/settings/index'),
  '/pkg-auth/pages/blocked/index': () => import('@/pkg-auth/pages/blocked/index'),
  '/pkg-auth/pages/verify/index': () => import('@/pkg-auth/pages/verify/index'),
  '/pkg-browse/pages/user/index': () => import('@/pkg-browse/pages/user/index'),
  '/pkg-browse/pages/match/index': () => import('@/pkg-browse/pages/match/index'),
  '/pkg-browse/pages/mylist/index': () => import('@/pkg-browse/pages/mylist/index'),
  '/pkg-browse/pages/watchers/index': () => import('@/pkg-browse/pages/watchers/index'),
  '/pkg-browse/pages/comments/index': () => import('@/pkg-browse/pages/comments/index'),
  '/pkg-browse/pages/favorites/index': () => import('@/pkg-browse/pages/favorites/index'),
  '/pkg-vision/pages/scan/index': () => import('@/pkg-vision/pages/scan/index'),
  '/pkg-vision/pages/scan-pr/index': () => import('@/pkg-vision/pages/scan-pr/index'),
  '/pkg-vision/pages/scan-vision/index': () => import('@/pkg-vision/pages/scan-vision/index'),
  '/pkg-vision/pages/vision-result/index': () => import('@/pkg-vision/pages/vision-result/index'),
  '/pkg-browse/pages/following/index': () => import('@/pkg-browse/pages/following/index'),
  '/pkg-browse/pages/history/index': () => import('@/pkg-browse/pages/history/index'),
  '/pkg-trade/pages/report-listing/index': () => import('@/pkg-trade/pages/report-listing/index'),
  '/pkg-trade/pages/report-user/index': () => import('@/pkg-trade/pages/report-user/index'),
  '/pkg-trade/pages/my-reports/index': () => import('@/pkg-trade/pages/my-reports/index'),
  // 静态法务与帮助页（未定内容页面，实际内容由 zzstar 决策）
  '/pkg-legal/pages/about/index': () => import('@/pkg-legal/pages/about/index'),
  '/pkg-legal/pages/terms/index': () => import('@/pkg-legal/pages/terms/index'),
  '/pkg-legal/pages/privacy/index': () => import('@/pkg-legal/pages/privacy/index'),
  '/pkg-legal/pages/feedback/index': () => import('@/pkg-legal/pages/feedback/index'),
}

/** 与 app.config.ts 的 tabBar.list 一致：这些路由在真机上会多渲染一层自定义 TabBar */
const TAB_ROUTES = [
  'pages/home/index',
  'pages/wish/index',
  'pages/sell/index',
  'pages/chat/index',
  'pages/profile/index',
]

function isTabRoute(path: string): boolean {
  return TAB_ROUTES.some((route) => path.includes(route))
}

function PageMount({ path, params }: { path: string; params: Record<string, string> }) {
  const [Component, setComponent] = useState<ComponentType | null>(null)

  useEffect(() => {
    let alive = true
    const loader = PAGES[path]
    if (!loader) {
      setComponent(null)
      return () => {
        alive = false
      }
    }
    void loader().then((mod) => {
      if (alive) setComponent(() => mod.default)
    })
    return () => {
      alive = false
    }
  }, [path])

  useEffect(() => {
    document.title = `${path}${params.id ? ` (${params.id})` : ''}`
  }, [path, params.id])

  if (!Component) return <div className="preview-loading">加载中…</div>
  return <Component />
}

function Shell() {
  const router = useRouterState()
  // key 让同一组件在换参数（如不同商品 id）时重新挂载，避免残留上一次的 state
  return (
    <>
      <PageMount
        key={`${router.path}?${JSON.stringify(router.params)}`}
        path={router.path}
        params={router.params}
      />
      {/* 真机由小程序框架渲染 custom-tab-bar；预览里手动挂上，保证两边是同一套组件 */}
      {isTabRoute(router.path) ? <CustomTabBar /> : null}
    </>
  )
}

const container = document.getElementById('preview-root')
if (!container) throw new Error('#preview-root 不存在')
createRoot(container).render(<Shell />)
