import { focusManager, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
