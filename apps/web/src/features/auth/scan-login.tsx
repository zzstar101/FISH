import {
  SCAN_CONFIRM_PAGE,
  type ScanTicketResponse,
  type ScanUser,
} from '@fish/contracts/auth/scan'
import { Button } from '@fish/ui/button'
import { Spinner } from '@fish/ui/spinner'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { FormAlert } from './form'
import { authKeys } from './queries'
import { createScanTicket, exchangeScanTicket, fetchScanTicketStatus } from './scan-api'
import { isScanTicketExpired, nextScanPollDelayMs } from './scan-poll'

type TicketData = Pick<ScanTicketResponse, 'ticket' | 'qrCodeDataUrl' | 'expiresAt'>

type ScanState =
  | { phase: 'idle' | 'creating' }
  | { phase: 'pending' | 'expired'; ticket: TicketData }
  | { phase: 'confirmed'; ticket: TicketData; user: ScanUser }
  | { phase: 'invalid' }
  | { phase: 'create-error'; message: string }
  | { phase: 'status-error'; ticket: TicketData; message: string }

const AGREEMENT_NOTICE = '请先阅读并同意《用户协议》和《隐私政策》'

function isTicketInvalidError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'SCAN_TICKET_INVALID'
}

function isTicketConflictError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'SCAN_TICKET_CONFLICT'
}

/** 把建票/查状态的失败收敛成可执行文案；网络层异常走可重试分支。 */
function scanFailureMessage(error: unknown, stage: 'create' | 'status' | 'exchange'): string {
  if (error instanceof ApiError) {
    if (error.code === 'WECHAT_DISABLED') {
      return '微信扫码登录暂不可用，请改用账号密码登录'
    }
    if (error.code === 'WECHAT_QR_UNAVAILABLE') {
      return '暂时无法生成登录二维码，请稍后重试'
    }
  }
  if (stage === 'create') return '二维码生成失败，请检查网络后重试'
  return '网络连接失败，请重试'
}

/**
 * Web 扫码登录面板。
 *
 * verifier 只放 ref，不参与渲染也不落 storage；所有异步响应都同时校验 seq 与 ticket，
 * 页面卸载或重新取码后迟到的旧响应不能覆盖当前二维码。
 */
export function ScanLoginPanel({
  active,
  agreed,
  target,
}: {
  active: boolean
  agreed: boolean
  target: string
}) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<ScanState>({ phase: 'idle' })
  const [notice, setNotice] = useState<string | null>(null)
  const [exchangePending, setExchangePending] = useState(false)
  const mountedRef = useRef(true)
  const autoCreateRef = useRef(false)
  const creatingRef = useRef(false)
  const requestSeqRef = useRef(0)
  const ticketRef = useRef<string | null>(null)
  const verifierRef = useRef<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const startCreate = useCallback(() => {
    if (creatingRef.current) return
    creatingRef.current = true
    const seq = ++requestSeqRef.current
    ticketRef.current = null
    verifierRef.current = null
    setNotice(null)
    setExchangePending(false)
    setState({ phase: 'creating' })

    void createScanTicket()
      .then((ticket) => {
        if (!mountedRef.current || seq !== requestSeqRef.current) return
        verifierRef.current = ticket.verifier
        ticketRef.current = ticket.ticket
        setState({
          phase: 'pending',
          ticket: {
            ticket: ticket.ticket,
            qrCodeDataUrl: ticket.qrCodeDataUrl,
            expiresAt: ticket.expiresAt,
          },
        })
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || seq !== requestSeqRef.current) return
        setState({ phase: 'create-error', message: scanFailureMessage(error, 'create') })
      })
      .finally(() => {
        if (seq === requestSeqRef.current) creatingRef.current = false
      })
  }, [])

  // StrictMode 会重复执行 effect；用 ref 保证同一次页面挂载只自动建一张票。
  useEffect(() => {
    if (!active || autoCreateRef.current) return
    autoCreateRef.current = true
    startCreate()
  }, [active, startCreate])

  const pendingTicket = state.phase === 'pending' ? state.ticket : null

  useEffect(() => {
    if (!active || pendingTicket === null) return
    const verifier = verifierRef.current
    const seq = requestSeqRef.current
    const ticket = pendingTicket.ticket
    if (verifier === null) {
      setState({ phase: 'invalid' })
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const isCurrent = () =>
      !cancelled &&
      mountedRef.current &&
      seq === requestSeqRef.current &&
      ticketRef.current === ticket &&
      verifierRef.current === verifier

    const schedule = () => {
      if (!isCurrent()) return
      const remainingMs = Date.parse(pendingTicket.expiresAt) - Date.now()
      if (isScanTicketExpired(pendingTicket.expiresAt) || remainingMs <= 0) {
        setState({ phase: 'expired', ticket: pendingTicket })
        return
      }
      timer = setTimeout(tick, Math.min(nextScanPollDelayMs(attempt), remainingMs))
    }

    const tick = async () => {
      if (!isCurrent()) return
      if (isScanTicketExpired(pendingTicket.expiresAt)) {
        setState({ phase: 'expired', ticket: pendingTicket })
        return
      }
      try {
        const result = await fetchScanTicketStatus(ticket, verifier)
        if (!isCurrent()) return
        if (result.status === 'confirmed') {
          setState({ phase: 'confirmed', ticket: pendingTicket, user: result.user })
          return
        }
        if (result.status === 'expired') {
          setState({ phase: 'expired', ticket: pendingTicket })
          return
        }
        attempt += 1
        schedule()
      } catch (error) {
        if (!isCurrent()) return
        if (isTicketInvalidError(error)) {
          setState({ phase: 'invalid' })
          return
        }
        setState({
          phase: 'status-error',
          ticket: pendingTicket,
          message: scanFailureMessage(error, 'status'),
        })
      }
    }

    schedule()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [active, pendingTicket])

  async function confirmLogin() {
    if (state.phase !== 'confirmed' || exchangePending) return
    if (!agreed) {
      setNotice(AGREEMENT_NOTICE)
      return
    }

    const verifier = verifierRef.current
    const seq = requestSeqRef.current
    const ticket = state.ticket.ticket
    if (verifier === null || ticketRef.current !== ticket) {
      setState({ phase: 'invalid' })
      return
    }

    setNotice(null)
    setExchangePending(true)
    try {
      const user = await exchangeScanTicket(ticket, verifier)
      if (
        !mountedRef.current ||
        seq !== requestSeqRef.current ||
        ticketRef.current !== ticket ||
        verifierRef.current !== verifier
      ) {
        return
      }
      queryClient.setQueryData(authKeys.me(), user)
      window.location.assign(target)
    } catch (error) {
      if (!mountedRef.current || seq !== requestSeqRef.current || ticketRef.current !== ticket) {
        return
      }
      if (isTicketInvalidError(error) || isTicketConflictError(error)) {
        setState({ phase: 'invalid' })
        return
      }
      setNotice(scanFailureMessage(error, 'exchange'))
    } finally {
      if (mountedRef.current && seq === requestSeqRef.current) setExchangePending(false)
    }
  }

  function retryStatus() {
    setState((previous) =>
      previous.phase === 'status-error' ? { phase: 'pending', ticket: previous.ticket } : previous,
    )
  }

  if (state.phase === 'idle' || state.phase === 'creating') {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-ink-3 text-sm">
        <Spinner className="size-5 text-primary" />
        正在生成登录二维码…
      </div>
    )
  }

  if (state.phase === 'create-error') {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3">
        <FormAlert message={state.message} />
        <Button className="w-full" onClick={startCreate} type="button">
          重新获取
        </Button>
      </div>
    )
  }

  if (state.phase === 'invalid') {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
        <span className="text-4xl">⌛</span>
        <p className="text-ink-2 text-sm">登录链接已失效，请重新扫码</p>
        <Button className="w-full" onClick={startCreate} type="button">
          重新获取
        </Button>
      </div>
    )
  }

  if (state.phase === 'status-error') {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3">
        <FormAlert message={state.message} />
        <Button className="w-full" onClick={retryStatus} type="button">
          重试
        </Button>
      </div>
    )
  }

  if (state.phase === 'expired') {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
        <span className="text-4xl">⌛</span>
        <p className="text-ink-2 text-sm">二维码已过期</p>
        <Button className="w-full" onClick={startCreate} type="button">
          重新获取
        </Button>
      </div>
    )
  }

  if (state.phase === 'confirmed') {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
        <span className="text-4xl">✓</span>
        <div>
          <p className="text-ink-3 text-sm">即将登录为</p>
          <div className="mt-2 flex items-center justify-center gap-2">
            {state.user.avatarUrl === null ? (
              <span className="flex size-9 items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground">
                {state.user.nickname.slice(0, 1)}
              </span>
            ) : (
              <img alt="" className="size-9 rounded-full object-cover" src={state.user.avatarUrl} />
            )}
            <span className="font-semibold text-lg">{state.user.nickname}</span>
          </div>
        </div>
        {notice !== null && <FormAlert message={notice} />}
        <Button
          className="w-full"
          disabled={exchangePending}
          onClick={() => void confirmLogin()}
          type="button"
        >
          {exchangePending ? (
            <>
              <Spinner className="size-4" />
              确认中…
            </>
          ) : (
            '确认登录'
          )}
        </Button>
      </div>
    )
  }

  if (state.phase !== 'pending') return null

  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
      <p className="text-ink-2 text-sm">请使用微信扫一扫，在小程序内确认登录</p>
      {state.ticket.qrCodeDataUrl === null ? (
        <div className="w-full space-y-3 rounded-lg bg-secondary/45 p-3 text-left">
          <p className="text-ink-2 text-xs">
            当前是 stub 环境，无法生成真实小程序码。请用微信开发者工具打开确认页：
          </p>
          <code className="block break-all rounded bg-background px-2 py-1.5 text-xs">
            {state.ticket.ticket}
          </code>
          <p className="text-ink-3 text-xs leading-relaxed">
            编译模式启动页面填 {SCAN_CONFIRM_PAGE}，启动参数 scene 填上方 ticket。
          </p>
        </div>
      ) : (
        <img
          alt="微信小程序扫码登录二维码"
          className="size-56 rounded-lg bg-white p-2 shadow-sm"
          src={state.ticket.qrCodeDataUrl}
        />
      )}
      {notice !== null && <FormAlert message={notice} />}
    </div>
  )
}
