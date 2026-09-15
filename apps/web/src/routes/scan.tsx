import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ScannerPanel, type ScanResult } from '../features/scanner/scanner'

export const Route = createFileRoute('/scan')({
  component: ScanRoute,
})

function ScanRoute() {
  const [result, setResult] = useState<ScanResult | null>(null)

  return (
    <main className="min-h-dvh bg-bg px-3 pt-5 pb-8">
      <header className="mb-5 flex items-center gap-3">
        <button
          aria-label="返回"
          className="flex size-10 items-center justify-center rounded-full bg-surface text-ink"
          onClick={() => window.history.back()}
          type="button"
        >
          ←
        </button>
        <div>
          <h1 className="font-semibold text-lg">扫码</h1>
          <p className="text-ink-3 text-xs">扫描二维码，结果交给对应业务处理</p>
        </div>
      </header>
      <ScannerPanel onScan={setResult} />
      {result ? (
        <p className="mt-4 rounded-xl bg-success-soft px-3 py-2 text-success text-sm">
          已读取扫码内容：{result.rawValue}
        </p>
      ) : null}
    </main>
  )
}
