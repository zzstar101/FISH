import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { Bell, MessageCircle, Plus, Search } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useAuth } from '../auth/auth-provider'

/** PC Web 顶栏：品牌、全局搜索、发布入口、通知 / 消息、当前用户。 */
export function TopBar() {
  const navigate = useNavigate()
  const { me } = useAuth()
  const [keyword, setKeyword] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const q = keyword.trim()
    void navigate({ to: '/search', search: q.length > 0 ? { q } : {} })
  }

  return (
    <header className="sticky top-0 z-30 h-16 border-line border-b bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-7 px-8">
        <Link className="flex min-w-[220px] items-center gap-2.5" to="/">
          <img alt="鱼小应" className="size-8 object-contain" src="/pc/brand-fish.png" />
          <span className="font-bold text-[17px] tracking-[-0.02em]">鱼小应</span>
          <span className="text-ink-3 text-xs">广应科校内二手</span>
        </Link>

        <form className="flex max-w-[640px] flex-1" onSubmit={submit}>
          <div className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-surface-2 px-3.5 focus-within:ring-3 focus-within:ring-brand/15">
            <Search className="size-4 shrink-0 text-ink-3" />
            <Input
              className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
              maxLength={50}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜校园好物，如 自行车 / 考研资料"
              value={keyword}
            />
          </div>
        </form>

        <div className="ml-auto flex items-center gap-2">
          <Button asChild className="h-10 px-4">
            <Link to="/publish">
              <Plus className="size-4" />
              发布闲置
            </Link>
          </Button>
          <Link
            aria-label="通知"
            className="grid size-10 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            to="/notifications"
          >
            <Bell className="size-5" />
          </Link>
          <Link
            aria-label="消息"
            className="grid size-10 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            to="/messages"
          >
            <MessageCircle className="size-5" />
          </Link>
          <Link aria-label="我的" className="ml-1" to="/profile">
            <UserAvatar
              avatarUrl={me?.avatarUrl ?? null}
              emoji={me?.nickname.slice(0, 1) ?? '鱼'}
              fallbackClassName="text-sm"
              size="default"
            />
          </Link>
        </div>
      </div>
    </header>
  )
}
