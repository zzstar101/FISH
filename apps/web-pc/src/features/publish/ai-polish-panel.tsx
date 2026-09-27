import type { AiPolishCandidate, AiPolishProvider } from '@fish/contracts/ai/schema'
import { Alert, AlertDescription, AlertTitle } from '@fish/ui/alert'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { Spinner } from '@fish/ui/spinner'
import { ChevronLeft, ChevronRight, RefreshCw, Sparkles } from 'lucide-react'
import type { PolishFailureView } from './form-model'

export type PolishState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | {
      phase: 'ready'
      candidates: AiPolishCandidate[]
      index: number
      provider: AiPolishProvider
      redacted: boolean
    }
  | { phase: 'failed'; view: PolishFailureView }

type AiPolishPanelProps = {
  state: PolishState
  disabledReason: string | null
  coolingDown: boolean
  onPolish: () => void
  onSelect: (index: number) => void
  onApply: (text: string) => void
}

export function AiPolishPanel({
  state,
  disabledReason,
  coolingDown,
  onPolish,
  onSelect,
  onApply,
}: AiPolishPanelProps) {
  const candidate = state.phase === 'ready' ? state.candidates[state.index] : undefined
  const hasCandidates = state.phase === 'ready' && state.candidates.length > 0
  const canStart = disabledReason === null && state.phase !== 'loading' && !coolingDown

  return (
    <Card className="gap-0 border border-line p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-brand" />
            <h2 className="font-semibold text-lg">AI 描述润色</h2>
          </div>
          <p className="mt-1.5 text-ink-3 text-sm">
            只有点击按钮才会请求；候选采用前不会改动你的原文。
          </p>
        </div>
        {state.phase === 'ready' && state.provider === 'stub' ? (
          <Badge variant="warn">演示文案</Badge>
        ) : null}
      </div>

      <Button
        className="mt-4 w-full"
        disabled={!canStart}
        onClick={onPolish}
        type="button"
        variant={state.phase === 'idle' ? 'default' : 'outline'}
      >
        {state.phase === 'loading' ? (
          <Spinner className="size-4" />
        ) : hasCandidates ? (
          <RefreshCw className="size-4" />
        ) : (
          <Sparkles className="size-4" />
        )}
        {coolingDown
          ? '请稍后再试'
          : state.phase === 'loading'
            ? '正在生成候选…'
            : hasCandidates
              ? '重新生成候选'
              : '生成润色候选'}
      </Button>

      {disabledReason ? <p className="mt-2 text-ink-3 text-xs">{disabledReason}</p> : null}

      {state.phase === 'failed' ? (
        <Alert className="mt-4" variant="destructive">
          <AlertTitle>{state.view.message}</AlertTitle>
          <AlertDescription>
            <p>{state.view.detail}</p>
            {state.view.canRetry ? (
              <Button className="mt-2" onClick={onPolish} size="sm" type="button" variant="outline">
                <RefreshCw className="size-3.5" />
                手动重试
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {state.phase === 'ready' && candidate ? (
        <div className="mt-4 rounded-2xl bg-brand-soft p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-brand text-sm">
              候选 {state.index + 1}/{state.candidates.length}
            </span>
            <div className="flex gap-1">
              <Button
                aria-label="上一条候选"
                disabled={state.candidates.length <= 1}
                onClick={() =>
                  onSelect((state.index - 1 + state.candidates.length) % state.candidates.length)
                }
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                aria-label="下一条候选"
                disabled={state.candidates.length <= 1}
                onClick={() => onSelect((state.index + 1) % state.candidates.length)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          <p className="mt-3 whitespace-pre-wrap text-ink text-sm leading-6">{candidate.text}</p>
          {state.redacted ? (
            <p className="mt-3 text-ink-3 text-xs">请求前已对联系方式等敏感信息做脱敏。</p>
          ) : null}
          <Button className="mt-4 w-full" onClick={() => onApply(candidate.text)} type="button">
            采用此文案
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
