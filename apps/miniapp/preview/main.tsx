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

/** 与 src/app.config.ts 的 pages 一一对应（顺序、数量都必须一致）。分批合入，见 app.config.ts */
const PAGES: Record<string, () => Promise<{ default: ComponentType }>> = {
  '/pages/home/index': () => import('@/pages/home/index'),
  '/pages/wish/index': () => import('@/pages/wish/index'),
  '/pages/sell/index': () => import('@/pages/sell/index'),
  '/pages/chat/index': () => import('@/pages/chat/index'),
  '/pages/profile/index': () => import('@/pages/profile/index'),
  '/pages/orders/index': () => import('@/pages/orders/index'),
  '/pages/transaction-meetup/index': () => import('@/pages/transaction-meetup/index'),
  '/pages/login/index': () => import('@/pages/login/index'),
  '/pages/register/index': () => import('@/pages/register/index'),
  '/pages/verify/index': () => import('@/pages/verify/index'),
  '/pages/settings/index': () => import('@/pages/settings/index'),
  '/pages/category/index': () => import('@/pages/category/index'),
  '/pages/user/index': () => import('@/pages/user/index'),
  '/pages/match/index': () => import('@/pages/match/index'),
  '/pages/mylist/index': () => import('@/pages/mylist/index'),
  '/pages/watchers/index': () => import('@/pages/watchers/index'),
  '/pages/scan/index': () => import('@/pages/scan/index'),
  '/pages/conversation/index': () => import('@/pages/conversation/index'),
  '/pages/search/index': () => import('@/pages/search/index'),
  '/pages/listing-detail/index': () => import('@/pages/listing-detail/index'),
  '/pages/notifications/index': () => import('@/pages/notifications/index'),
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
