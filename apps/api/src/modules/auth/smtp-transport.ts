import type { Socket } from 'bun'
import type { MailTransport, VerificationMail } from './verification-provider'

/**
 * 生产邮件 transport：SMTP（飞书企业邮箱 smtp.feishu.cn:465，隐式 TLS）。
 *
 * 不引第三方 SMTP 库：校验码邮件只需「EHLO → AUTH → MAIL/RCPT/DATA → QUIT」一条直线流程，
 * 直接跑在 `Bun.connect` 上。只支持隐式 TLS（`secure=true`）与明文（`secure=false`，仅测试），
 * 不做 STARTTLS。
 *
 * 错误信息只带阶段名与 SMTP 状态码：服务器回复文本可能回显收件人，口令/验证码更不能进日志
 * （与 Resend transport 同一口径）。
 */
export type SmtpTransportConfig = {
  host: string
  port: number
  /** true = 隐式 TLS（连接即握手，465）；false = 明文 TCP（只给本机测试）。 */
  secure: boolean
  user: string
  pass: string
  /** 发件人，如 `鱼小应 <noreply@example.com>` 或裸地址。 */
  from: string
  /**
   * 连接到 DATA 250 的总超时毫秒数，默认 7s。加上 QUIT 最多再等的 1s 仍低于 `Bun.serve`
   * 的 `idleTimeout`（`apps/api/src/index.ts` 显式设成 `API_HTTP_IDLE_TIMEOUT_SECONDS` = 22s，
   * 由手机号绑定的上游预算反推，见 `./phone-bind-budget.ts`），发码请求不会先被 HTTP 层掐断。
   */
  timeoutMs?: number
}

type SmtpReply = { code: number; lines: string[] }

/**
 * 只接受可打印 ASCII 的 dot-atom 地址：local-part 不允许首尾/连续的点，域名逐标签校验
 * （标签不以连字符开头或结尾）；不允许空白、尖括号、引号等，杜绝 CRLF / 命令注入。
 */
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?'
const ADDRESS_PATTERN = new RegExp(`^${ATOM}(?:\\.${ATOM})*@${LABEL}(?:\\.${LABEL})*$`)
const MAX_ADDRESS_LENGTH = 254
/** 单条回复（含多行续行）的字节上限：服务端异常时不无限攒内存。 */
const MAX_REPLY_BYTES = 64 * 1024
/** DATA 已被接收后，等 QUIT 回复的上限：只是礼节，不拖住发码请求。 */
const QUIT_WAIT_MS = 1_000

function isValidAddress(address: string): boolean {
  return address.length <= MAX_ADDRESS_LENGTH && ADDRESS_PATTERN.test(address)
}

/** 解析 `显示名 <addr>` 或裸 `addr`。格式不对直接抛错（装配期 = 启动期失败）。 */
export function parseMailbox(value: string): { name: string; address: string } {
  const trimmed = value.trim()
  const angle = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed)
  const name = (angle?.[1] ?? '').trim().replace(/^"(.*)"$/, '$1')
  const address = angle ? (angle[2] ?? '') : trimmed
  if (!isValidAddress(address) || /[\r\n]/.test(name)) {
    throw new Error('SMTP_FROM 格式非法：应为 `显示名 <地址>` 或裸地址')
  }
  return { name, address }
}

/** RFC 2047 encoded-word（UTF-8 / B）。按码点切块，单个 encoded-word 不超过 75 字符。 */
function encodeHeaderWords(value: string): string {
  const words: string[] = []
  let chunk = ''
  for (const char of value) {
    // 39 字节 → 52 个 base64 字符 + 12 字符外壳 = 64；加上 `Subject: ` 前缀整行仍 ≤ 76。
    if (Buffer.byteLength(chunk + char, 'utf8') > 39) {
      words.push(chunk)
      chunk = ''
    }
    chunk += char
  }
  if (chunk) words.push(chunk)
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`)
    .join('\r\n ')
}

/** base64 正文按 76 字符折行（base64 字母表没有 `.`，行首不会出现点）。 */
function encodeBody(content: string): string {
  const canonical = content.replace(/\r?\n/g, '\r\n')
  const encoded = Buffer.from(canonical, 'utf8').toString('base64')
  return (encoded.match(/.{1,76}/g) ?? []).join('\r\n')
}

/** RFC 5322 日期：`Sun, 01 Nov 2026 10:46:02 +0000`。 */
function formatDate(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000')
}

export function buildMimeMessage(
  from: { name: string; address: string },
  mail: VerificationMail,
  now: Date = new Date(),
): string {
  const domain = from.address.slice(from.address.lastIndexOf('@') + 1)
  const boundary = `fish-${crypto.randomUUID()}`
  const fromHeader = from.name ? `${encodeHeaderWords(from.name)} <${from.address}>` : from.address
  const lines = [
    `From: ${fromHeader}`,
    `To: <${mail.to}>`,
    `Subject: ${encodeHeaderWords(mail.subject)}`,
    `Date: ${formatDate(now)}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(mail.html),
    `--${boundary}--`,
    '',
  ]
  return lines.join('\r\n')
}

/** 把服务端字节流切成 SMTP 回复（处理 `250-` 多行续行），按到达顺序交给 `next()`。 */
function createReplyReader() {
  const decoder = new TextDecoder()
  let buffer = ''
  let pending: string[] = []
  let pendingBytes = 0
  const replies: SmtpReply[] = []
  let waiter: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void } | null = null
  let failure: Error | null = null

  function fail(error: Error) {
    if (failure) return
    failure = error
    waiter?.reject(error)
    waiter = null
  }

  function deliver(reply: SmtpReply) {
    if (waiter) {
      waiter.resolve(reply)
      waiter = null
    } else {
      replies.push(reply)
    }
  }

  return {
    fail,
    push(chunk: Uint8Array) {
      if (failure) return
      buffer += decoder.decode(chunk, { stream: true })
      // 按 LF 切行并去掉行尾 CR：容忍不规范服务器的裸 LF 行尾。
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        const match = /^(\d{3})([ -])(.*)$/.exec(line) ?? /^(\d{3})()()$/.exec(line)
        if (!match) {
          fail(new Error('SMTP 回复格式非法'))
          return
        }
        pending.push(match[3] ?? '')
        pendingBytes += line.length
        if (match[2] !== '-') {
          deliver({ code: Number(match[1]), lines: pending })
          pending = []
          pendingBytes = 0
        }
        index = buffer.indexOf('\n')
      }
      // 未结束的多行回复（一直 `250-`）与未换行的残行合计封顶。
      if (pendingBytes + buffer.length > MAX_REPLY_BYTES) fail(new Error('SMTP 回复过长'))
    },
    next(): Promise<SmtpReply> {
      const queued = replies.shift()
      if (queued) return Promise.resolve(queued)
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject }
      })
    },
  }
}

/** 选认证机制：优先 PLAIN（一次往返），其次 LOGIN；都不支持则拒绝发送（不明文裸发）。 */
function pickAuthMechanism(ehlo: SmtpReply): 'PLAIN' | 'LOGIN' {
  const mechanisms = new Set<string>()
  for (const line of ehlo.lines.slice(1)) {
    const [keyword, ...rest] = line
      .trim()
      .toUpperCase()
      .split(/[\s=]+/)
    if (keyword === 'AUTH') for (const item of rest) mechanisms.add(item)
  }
  if (mechanisms.has('PLAIN')) return 'PLAIN'
  if (mechanisms.has('LOGIN')) return 'LOGIN'
  throw new Error('SMTP 服务器未提供 PLAIN / LOGIN 认证')
}

const encoder = new TextEncoder()

export function createSmtpTransport(config: SmtpTransportConfig): MailTransport {
  const timeoutMs = config.timeoutMs ?? 7_000
  const from = parseMailbox(config.from)
  const fromDomain = from.address.slice(from.address.lastIndexOf('@') + 1)
  const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')

  async function deliver(mail: VerificationMail, message: string): Promise<void> {
    const reader = createReplyReader()
    // 用对象承载连接状态：这些字段在 socket 回调里改写，局部 let 会被 TS 的控制流收窄成初值。
    // accepted：DATA 的 250 到手后才置 true。在那之前的任何失败（含 250 丢失 / 迟到）都按失败
    // 上报——结局未知时宁可让用户重发，也不把可能没送达的码当成已发。
    const conn: {
      socket: Socket<undefined> | null
      closed: boolean
      finished: boolean
      accepted: boolean
    } = { socket: null, closed: false, finished: false, accepted: false }
    let drainWaiter: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`SMTP 投递超时（${timeoutMs}ms）`)
        reader.fail(error)
        reject(error)
      }, timeoutMs)
    })

    async function writeAll(data: string): Promise<void> {
      let bytes = encoder.encode(data)
      while (bytes.length > 0) {
        if (!conn.socket || conn.closed) throw new Error('SMTP 连接已关闭')
        const written = conn.socket.write(bytes)
        if (written < 0) throw new Error('SMTP 连接已关闭')
        bytes = bytes.subarray(written)
        if (bytes.length > 0) {
          // 背压：等 drain 再写剩余部分；连接断开 / 超时由 reader.fail 与总超时兜底。
          await new Promise<void>((resolve) => {
            drainWaiter = resolve
          })
        }
      }
    }

    async function command(line: string, expected: number[], stage: string): Promise<SmtpReply> {
      if (line) await writeAll(`${line}\r\n`)
      const reply = await reader.next()
      if (!expected.includes(reply.code)) throw new Error(`SMTP ${stage} 失败 (${reply.code})`)
      return reply
    }

    async function conversation(): Promise<void> {
      try {
        conn.socket = await Bun.connect({
          hostname: config.host,
          port: config.port,
          tls: config.secure ? { serverName: config.host } : false,
          socket: {
            open(s) {
              conn.socket = s
              // 总超时已触发、外层早已返回：迟到的连接直接关掉，不泄漏。
              if (conn.finished) s.terminate()
            },
            data(_s, chunk) {
              reader.push(chunk)
            },
            drain() {
              drainWaiter?.()
              drainWaiter = null
            },
            close() {
              conn.closed = true
              reader.fail(new Error('SMTP 连接被服务器关闭'))
              drainWaiter?.()
            },
            error() {
              reader.fail(new Error('SMTP 连接异常'))
            },
            // 显式检查证书校验结果：失败时给出明确原因并立即断开，而不是表现为「连接被关闭」。
            handshake(s, authorized) {
              if (!authorized) {
                reader.fail(new Error('SMTP TLS 证书校验失败'))
                s.terminate()
              }
            },
            connectError() {
              // 拒绝原因由 Bun.connect 的 promise 抛出，下面统一包装。
            },
          },
        })
      } catch (error) {
        throw new Error('SMTP 连接失败', { cause: error })
      }
      if (conn.finished) {
        conn.socket.terminate()
        return
      }

      await command('', [220], 'greeting')
      const ehlo = await command(`EHLO ${fromDomain}`, [250], 'EHLO')
      if (pickAuthMechanism(ehlo) === 'PLAIN') {
        await command(`AUTH PLAIN ${b64(`\0${config.user}\0${config.pass}`)}`, [235], 'AUTH')
      } else {
        await command('AUTH LOGIN', [334], 'AUTH')
        await command(b64(config.user), [334], 'AUTH')
        await command(b64(config.pass), [235], 'AUTH')
      }
      await command(`MAIL FROM:<${from.address}>`, [250], 'MAIL FROM')
      await command(`RCPT TO:<${mail.to}>`, [250, 251], 'RCPT TO')
      await command('DATA', [354], 'DATA')
      // 点填充（RFC 5321 §4.5.2）：base64 正文不会以 `.` 开头，这里兜底所有行。
      const stuffed = message.replace(/(^|\r\n)\./g, '$1..')
      await command(`${stuffed}\r\n.`, [250], 'DATA 投递')
      // 250 之后邮件已被服务器接收、投递即成功：QUIT 只等一小会儿，它的失败 / 超时都不影响结果。
      conn.accepted = true
      clearTimeout(timer)
      await Promise.race([command('QUIT', [221], 'QUIT'), Bun.sleep(QUIT_WAIT_MS)]).catch(
        () => undefined,
      )
    }

    try {
      await Promise.race([conversation(), timeout])
    } catch (error) {
      if (!conn.accepted) throw error
    } finally {
      conn.finished = true
      clearTimeout(timer)
      if (conn.socket && !conn.closed) conn.socket.terminate()
    }
  }

  return {
    async send(mail: VerificationMail): Promise<void> {
      // 收件地址进 RCPT TO 与 To 头：只放行简单 ASCII 地址，杜绝 CRLF 头/命令注入。
      // 错误信息不回显地址本身。
      if (!isValidAddress(mail.to)) throw new Error('SMTP 收件地址格式非法')
      await deliver(mail, buildMimeMessage(from, mail))
    },
  }
}
