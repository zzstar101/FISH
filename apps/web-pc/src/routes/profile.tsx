import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useAuth } from '../features/auth/auth-provider'
import { useLogout } from '../features/auth/queries'

export const Route = createFileRoute('/profile')({ component: ProfilePage })

function ProfilePage() {
  const { me } = useAuth()
  const logout = useLogout()
  const [logoutError, setLogoutError] = useState<string | null>(null)

  async function handleLogout() {
    setLogoutError(null)
    try {
      await logout.mutateAsync()
      window.location.assign('/pc/login')
    } catch {
      setLogoutError('退出登录失败，请稍后重试')
    }
  }

  return (
    <div>
      <h1 className="font-semibold text-2xl tracking-[-0.03em]">我的</h1>
      <Card className="mt-6 gap-0 border border-line p-8">
        <p className="text-ink-2 text-sm">
          当前登录：<span className="font-semibold text-ink">{me?.nickname ?? '未知用户'}</span>
        </p>
        <p className="mt-3 max-w-[640px] text-ink-3 text-sm leading-6">
          个人中心、我的发布、订单、校园认证将在个人主链 Issue
          接入。当前页面只验证登录守卫和退出登录闭环。
        </p>
        {logoutError !== null ? <p className="mt-5 text-danger text-sm">{logoutError}</p> : null}
        <Button
          className="mt-6 w-fit"
          disabled={logout.isPending}
          onClick={() => void handleLogout()}
          variant="outline"
        >
          {logout.isPending ? '正在退出…' : '退出登录'}
        </Button>
      </Card>
    </div>
  )
}
