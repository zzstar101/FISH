import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { Input } from '@fish/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@fish/ui/select'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { AUTH_STATUS_LABEL, formatDateTime, statusLabel, USER_ROLE_LABEL } from './display'
import { useAdminUsers } from './queries'

export type AdminUsersSearch = { q?: string; role?: string }

type PageState = { cursor: string | null; stack: (string | null)[] }

/**
 * 用户查询（#73 设计 §4.2）：学号精确 / 昵称前缀搜索 + 角色筛选，写入 URL（便于复制定位）；
 * 列表统一游标分页（不透明 cursor），本地维护分页栈实现「上一页/下一页」。
 */
export function UsersPage({ search }: { search: AdminUsersSearch }) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState(search.q ?? '')
  const [page, setPage] = useState<PageState>({ cursor: null, stack: [] })

  const query = useAdminUsers({
    q: search.q,
    role: search.role,
    cursor: page.cursor ?? undefined,
    limit: 20,
  })
  const body = query.data

  const applySearch = (patch: Partial<AdminUsersSearch>) => {
    setPage({ cursor: null, stack: [] })
    void navigate({ to: '/admin/users', search: { q: search.q, role: search.role, ...patch } })
  }

  const nextPage = () => {
    if (!body?.nextCursor) return
    setPage((prev) => ({ cursor: body.nextCursor, stack: [...prev.stack, prev.cursor] }))
  }
  const prevPage = () => {
    setPage((prev) => {
      const stack = [...prev.stack]
      const previous = stack.pop() ?? null
      return { cursor: previous, stack }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-semibold text-lg">用户查询</h1>
        <div className="flex items-center gap-2">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-2.5">
            <Search className="size-4 text-ink-3" />
            <Input
              className="h-auto w-44 border-0 bg-transparent p-0 text-sm shadow-none"
              maxLength={50}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applySearch({ q: draft.trim() || undefined })
              }}
              placeholder="学号精确 / 昵称前缀"
              value={draft}
            />
          </div>
          <Select
            onValueChange={(value) => applySearch({ role: value === 'all' ? undefined : value })}
            value={search.role ?? 'all'}
          >
            <SelectTrigger className="h-9 w-28 text-sm">
              {search.role ? (USER_ROLE_LABEL[search.role] ?? search.role) : '全部角色'}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部角色</SelectItem>
              <SelectItem value="USER">用户</SelectItem>
              <SelectItem value="ADMIN">管理员</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {query.isPending ? <LoadingState label="正在加载用户…" /> : null}
      {query.isError ? (
        <ErrorState message="用户列表加载失败" onRetry={() => void query.refetch()} />
      ) : null}
      {query.isSuccess && body && body.items.length === 0 ? (
        <EmptyState description="没有符合条件的用户" emoji="👤" />
      ) : null}

      {body && body.items.length > 0 ? (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">昵称 / 学号</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">校区</th>
                <th className="px-3 py-2 font-medium">认证</th>
                <th className="px-3 py-2 font-medium">角色</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">商品数</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">最近活动</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {body.items.map((item) => (
                <tr key={item.id} className="hover:bg-surface-2/60">
                  <td className="px-3 py-2.5">
                    <p className="font-medium">{item.nickname}</p>
                    <p className="mt-0.5 text-xs text-ink-3">{item.studentNoMasked}</p>
                  </td>
                  <td className="hidden px-3 py-2.5 text-ink-2 sm:table-cell">
                    {item.campus ?? '—'}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge
                      shape="pill"
                      variant={item.authStatus === 'VERIFIED' ? 'default' : 'secondary'}
                    >
                      {statusLabel(AUTH_STATUS_LABEL, item.authStatus)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">{statusLabel(USER_ROLE_LABEL, item.role)}</td>
                  <td className="hidden px-3 py-2.5 text-ink-2 md:table-cell">
                    {item.listingCount}
                  </td>
                  <td className="hidden px-3 py-2.5 text-ink-3 md:table-cell">
                    {formatDateTime(item.lastActivityAt)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Link
                      className="text-brand"
                      to="/admin/users/$userId"
                      params={{ userId: item.id }}
                    >
                      详情
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <button
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={page.stack.length === 0 || query.isPending}
          onClick={prevPage}
          type="button"
        >
          上一页
        </button>
        <button
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={!body?.nextCursor || query.isPending}
          onClick={nextPage}
          type="button"
        >
          下一页
        </button>
      </div>
    </div>
  )
}
