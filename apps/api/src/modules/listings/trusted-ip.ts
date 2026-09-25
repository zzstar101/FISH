import { isIP } from 'node:net'

export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw || raw !== raw.trim() || raw.includes(',')) return null
  if (isIP(raw) === 4) return raw
  if (isIP(raw) !== 6) return null
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw)
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1]
  try {
    return new URL(`http://[${raw}]/`).hostname.slice(1, -1)
  } catch {
    return null
  }
}

/** Ignore all client-supplied forwarding headers unless the TCP peer is the configured proxy. */
export function trustedClientIp(
  request: Request,
  peerIp: string | null,
  trustedProxyIp: string | null,
): string | null {
  const peer = normalizeIp(peerIp)
  if (!peer) return null
  if (trustedProxyIp) {
    if (peer !== normalizeIp(trustedProxyIp)) return null
    return normalizeIp(request.headers.get('x-real-ip'))
  }
  if (
    request.headers.has('x-real-ip') ||
    request.headers.has('x-forwarded-for') ||
    request.headers.has('cf-connecting-ip')
  )
    return null
  return peer
}
