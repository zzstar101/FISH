import { type AdminUserSummary, UserRoleSchema } from '@fish/contracts/admin/schema'
import { AuthStatusSchema } from '@fish/contracts/auth/user'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { FilterChips, ForbiddenInline, KeywordFilter, LoadMore } from './admin-filter'
import { adminLoadOutcome } from './admin-messages'
import { useAdminUsers } from './admin-queries'
import { cursorSearch, optionalSearch, trimmedSearch, withoutCursor } from './admin-search'
import { authStatusMeta, formatAdminDateTime, roleMeta } from './admin-view'

export type UsersSearch = {
  q?: string
  authStatus?: 'UNVERIFIED' | 'VERIFIED'
  role?: 'USER' | 'ADMIN'
  cursor?: string
}

/**
 * 用户查询页（#467 验收「用户：列表、搜索/分页、详情、治理状态」）。
 * 搜索口径是服务端的：`q` = 学号精确匹配或昵称前缀（`AdminUsersQuerySchema`）。
 * 条件全部在 URL；条件变化剥 cursor（`withoutCursor`）。
 */
export function UsersPage({ search }: { search: UsersSearch }) {
  const filters = { q: search.q, authStatus: search.authStatus, role: search.role }
  const users = useAdminUsers(filters)

  if (users.isError) {
    const outcome = adminLoadOutcome(users.error)
    if (outcome.kind === 'forbidden') return <ForbiddenInline />
    return <ErrorState message="用户列表加载失败" onRetry={() => void users.refetch()} />
  }

  const items = users.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">用户</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          学号精确匹配或昵称前缀搜索；学号已按服务端口径脱敏。
        </p>
      </div>

      <UsersFilters search={search} />

      {users.isPending ? <LoadingState label="正在加载用户…" /> : null}
      {users.isSuccess && items.length === 0 ? (
        <EmptyState description="换个关键词或清掉筛选试试" emoji="🔍" title="没有匹配的用户" />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {items.map((item) => (
            <UserRow key={item.id} search={search} user={item} />
          ))}
        </Card>
      ) : null}

      <LoadMore
        error={users.isFetchNextPageError}
        hasNextPage={users.hasNextPage}
        isFetchingNextPage={users.isFetchingNextPage}
        onNext={() => void users.fetchNextPage()}
        onRetry={() => void users.fetchNextPage()}
      />
    </div>
  )
}

function UsersFilters({ search }: { search: UsersSearch }) {
  const navigate = useNavigate()

  function update(next: Partial<UsersSearch>) {
    void navigate({ to: '/admin/users', search: { ...withoutCursor(search), ...next } })
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <KeywordFilter
        onCommit={(q) => update({ q })}
        placeholder="学号或昵称前缀"
        value={search.q}
      />
      <FilterChips
        ariaLabel="认证状态筛选"
        onChange={(authStatus) => update({ authStatus: authStatus as UsersSearch['authStatus'] })}
        options={[
          { value: 'UNVERIFIED', label: '未认证' },
          { value: 'VERIFIED', label: '已认证' },
        ]}
        value={search.authStatus}
      />
      <FilterChips
        ariaLabel="角色筛选"
        onChange={(role) => update({ role: role as UsersSearch['role'] })}
        options={[
          { value: 'USER', label: '用户' },
          { value: 'ADMIN', label: '管理员' },
        ]}
        value={search.role}
      />
    </div>
  )
}

/** 列表行：`search` 是来源查询条件（关键词/认证状态/角色），整份带进详情，
 * 详情页的「返回」才能回到同一视图（#467 五审 P2）。 */
function UserRow({ search, user }: { user: AdminUserSummary; search: UsersSearch }) {
  const authMeta = authStatusMeta(user.authStatus)
  const roleView = roleMeta(user.role)
  return (
    <Link
      className="flex items-center gap-4 p-4 transition-colors hover:bg-surface-2/60"
      params={{ userId: user.id }}
      search={withoutCursor(search)}
      to="/admin/users/$userId"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{user.nickname}</span>
          <Badge variant={authMeta.variant}>{authMeta.label}</Badge>
          <Badge variant={roleView.variant}>{roleView.label}</Badge>
        </div>
        <p className="mt-1 text-ink-3 text-xs">
          {user.studentNoMasked ?? '无学号（微信注册）'} · 注册于{' '}
          {formatAdminDateTime(user.createdAt)} · 商品 {user.listingCount} 件
          {user.lastActivityAt === null
            ? ' · 从未登录'
            : ` · 最近活跃 ${formatAdminDateTime(user.lastActivityAt)}`}
        </p>
      </div>
      <span aria-hidden className="text-ink-3 text-sm">
        ›
      </span>
    </Link>
  )
}

/** validateSearch 共用实现（路由文件薄壳，逻辑进可测层）。 */
export function parseUsersSearch(search: Record<string, unknown>): UsersSearch {
  const authStatus = optionalSearch(AuthStatusSchema, search.authStatus)
  const role = optionalSearch(UserRoleSchema, search.role)
  const q = trimmedSearch(search.q)
  const cursor = cursorSearch(search.cursor)
  return {
    ...(q !== undefined ? { q } : {}),
    ...(authStatus !== undefined ? { authStatus } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}
