import { focusManager, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startRecommendationQueue } from './features/recommendation/queue'
import { queryClient } from './lib/query-client'
import { router } from './router'
import './styles.css'

// React Query 默认只听 visibilitychange。另一浏览器窗口切换同源 Cookie 时，
// PC 页可能一直保持 visible；重新聚焦窗口同样需要触发 /me 身份复核。
focusManager.setEventListener((onFocus) => {
  const verify = () => onFocus()
  window.addEventListener('visibilitychange', verify)
  window.addEventListener('focus', verify)
  return () => {
    window.removeEventListener('visibilitychange', verify)
    window.removeEventListener('focus', verify)
  }
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('#root not found')
}

// 应用启动即补发上次离线积压的行为事件，并挂上后续的冲刷时机（联网 / 回前台 / 定时）。
startRecommendationQueue()

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
