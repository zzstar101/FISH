import { HealthResponseSchema } from '@fish/contracts/system/health'
import { Button } from '@fish/ui/button'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/api/health')
      return HealthResponseSchema.parse(await res.json())
    },
  })

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-6">
      <h1 className="font-bold text-2xl">FISH</h1>
      <p className="text-slate-600 text-sm">校内二手交易 · 移动端 PWA（骨架占位页，由 #4 替换）</p>

      <section className="rounded-lg border border-slate-200 p-4 text-sm">
        <p className="font-medium">API /health</p>
        {health.isPending && <p className="text-slate-500">检查中…</p>}
        {health.isError && <p className="text-red-600">不可用：{String(health.error)}</p>}
        {health.data && (
          <ul className="mt-2 space-y-1 text-slate-700">
            <li>status: {health.data.status}</li>
            <li>version: {health.data.version}</li>
            <li>
              db: {health.data.db.status} ({health.data.db.latencyMs}ms)
            </li>
          </ul>
        )}
      </section>

      <Button type="button">@fish/ui 样例按钮</Button>
    </main>
  )
}
