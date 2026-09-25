import {
  SCAN_VERIFIER_HEADER,
  ScanExchangeResponseSchema,
  type ScanTicketResponse,
  ScanTicketResponseSchema,
  type ScanTicketStatusResponse,
  ScanTicketStatusResponseSchema,
} from '@fish/contracts/auth/scan'
import type { Me } from '@fish/contracts/auth/user'
import { apiRequest } from '../../lib/api-client'

/**
 * 扫码登录四个端点里的三个客户端调用（confirm 由小程序负责）。
 * 每个响应都在进 UI 前过一遍 Contract，避免后端形状漂移被状态机静默吞掉。
 */
export async function createScanTicket(): Promise<ScanTicketResponse> {
  return ScanTicketResponseSchema.parse(
    await apiRequest('/auth/wechat/scan/ticket', { method: 'POST' }),
  )
}

export async function fetchScanTicketStatus(
  ticket: string,
  verifier: string,
): Promise<ScanTicketStatusResponse> {
  return ScanTicketStatusResponseSchema.parse(
    await apiRequest(`/auth/wechat/scan/ticket/${encodeURIComponent(ticket)}`, {
      headers: { [SCAN_VERIFIER_HEADER]: verifier },
    }),
  )
}

export async function exchangeScanTicket(ticket: string, verifier: string): Promise<Me> {
  return ScanExchangeResponseSchema.parse(
    await apiRequest(`/auth/wechat/scan/ticket/${encodeURIComponent(ticket)}/exchange`, {
      method: 'POST',
      headers: { [SCAN_VERIFIER_HEADER]: verifier },
    }),
  ).user
}
