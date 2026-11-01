import { afterEach, describe, expect, test } from 'bun:test'
import type { TCPSocketListener } from 'bun'
import { renderVerificationMail } from './mail-template'
import { createSmtpTransport } from './smtp-transport'

/**
 * 假 SMTP 服务器（明文 TCP，127.0.0.1）：记录命令序列与 DATA 内容，按选项拒绝某条命令
 * 或干脆不发问候（模拟卡死的服务器）。
 */
type FakeOptions = {
  /** EHLO 宣告的 AUTH 机制。 */
  auth?: string
  /** 命令动词 → 替换回复（如 RCPT → 550）。 */
  reject?: Record<string, string>
  /** 不发 220 问候，用来触发总超时。 */
  silent?: boolean
  /** 不回复 QUIT（邮件已被 DATA 250 接收）。 */
  quitSilent?: boolean
  /** EHLO 回一串永不结束的 `250-` 续行。 */
  ehloFlood?: boolean
}

type ConnState = { buffer: string; inData: boolean; data: string; login: 'none' | 'user' | 'pass' }

function startFakeSmtp(options: FakeOptions = {}) {
  const commands: string[] = []
  const messages: string[] = []
  let connections = 0
  let closedConnections = 0

  function handleLine(state: ConnState, line: string): string | null {
    if (state.inData) {
      if (line === '.') {
        state.inData = false
        messages.push(state.data)
        return '250 2.0.0 Ok: queued as FAKE1'
      }
      // 反向点填充。
      state.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`
      return null
    }
    commands.push(line)
    if (state.login === 'user') {
      state.login = 'pass'
      return '334 UGFzc3dvcmQ6'
    }
    if (state.login === 'pass') {
      state.login = 'none'
      return '235 2.7.0 Authentication successful'
    }
    const verb = (line.split(' ')[0] ?? '').toUpperCase()
    const rejected = options.reject?.[verb]
    if (rejected) return rejected
    switch (verb) {
      case 'EHLO':
        if (options.ehloFlood)
          return Array.from({ length: 2000 }, () => `250-${'x'.repeat(60)}`).join('\r\n')
        return `250-fake.local\r\n250-AUTH ${options.auth ?? 'LOGIN PLAIN'}\r\n250 8BITMIME`
      case 'AUTH':
        if (line.toUpperCase() === 'AUTH LOGIN') {
          state.login = 'user'
          return '334 VXNlcm5hbWU6'
        }
        return '235 2.7.0 Authentication successful'
      case 'MAIL':
      case 'RCPT':
        return '250 2.1.0 Ok'
      case 'DATA':
        state.inData = true
        state.data = ''
        return '354 End data with <CR><LF>.<CR><LF>'
      case 'QUIT':
        return options.quitSilent ? null : '221 2.0.0 Bye'
      default:
        return '502 5.5.2 Error: command not recognized'
    }
  }

  const server: TCPSocketListener<ConnState> = Bun.listen<ConnState>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        connections += 1
        socket.data = { buffer: '', inData: false, data: '', login: 'none' }
        if (!options.silent) socket.write('220 fake ESMTP\r\n')
      },
      data(socket, chunk) {
        const state = socket.data
        state.buffer += chunk.toString('utf8')
        let index = state.buffer.indexOf('\r\n')
        while (index !== -1) {
          const line = state.buffer.slice(0, index)
          state.buffer = state.buffer.slice(index + 2)
          const reply = handleLine(state, line)
          if (reply) socket.write(`${reply}\r\n`)
          if (reply?.startsWith('221')) socket.end()
          index = state.buffer.indexOf('\r\n')
        }
      },
      close() {
        closedConnections += 1
      },
    },
  })

  return {
    port: server.port,
    commands,
    messages,
    connections: () => connections,
    closedConnections: () => closedConnections,
    stop: () => server.stop(true),
  }
}

let fake: ReturnType<typeof startFakeSmtp> | null = null

afterEach(() => {
  fake?.stop()
  fake = null
})

function transportFor(port: number, timeoutMs?: number) {
  return createSmtpTransport({
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'noreply@example.com',
    pass: 'not-a-real-password',
    from: '鱼小应 <noreply@example.com>',
    timeoutMs,
  })
}

/** 轮询等待服务端回调落地（close 回调是异步的，不靠固定 sleep）。 */
async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await Bun.sleep(5)
  expect(condition()).toBe(true)
}

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')
const unb64 = (value: string) => Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8')

/** 解开头部折行并解码 RFC 2047 encoded-word（相邻 encoded-word 之间的空白按规范忽略）。 */
function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, encoded: string) => unb64(encoded))
}

function parseMessage(raw: string) {
  const split = raw.indexOf('\r\n\r\n')
  const headerBlock = raw.slice(0, split).replace(/\r\n /g, ' ')
  const headers = new Map<string, string>()
  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':')
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim())
  }
  const boundary = /boundary="([^"]+)"/.exec(headers.get('content-type') ?? '')?.[1] ?? ''
  const parts = raw
    .slice(split + 4)
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [head = '', body = ''] = part.replace(/^\r\n/, '').split('\r\n\r\n')
      return { head, body }
    })
  return { headers, parts }
}

describe('createSmtpTransport', () => {
  const mail = renderVerificationMail('student@school.edu.cn', '123456', 10)

  test('PLAIN：完整命令序列，头部 RFC 2047 编码，正文解码回渲染结果', async () => {
    fake = startFakeSmtp({ auth: 'LOGIN PLAIN' })
    await transportFor(fake.port).send(mail)

    expect(fake.commands).toEqual([
      'EHLO example.com',
      `AUTH PLAIN ${b64('\0noreply@example.com\0not-a-real-password')}`,
      'MAIL FROM:<noreply@example.com>',
      'RCPT TO:<student@school.edu.cn>',
      'DATA',
      'QUIT',
    ])

    const raw = fake.messages[0] ?? ''
    // 全文 CRLF：没有裸 LF。
    expect(/(^|[^\r])\n/.test(raw)).toBe(false)
    const { headers, parts } = parseMessage(raw)
    expect(headers.get('from')).toStartWith('=?UTF-8?B?')
    expect(decodeHeader(headers.get('from') ?? '')).toBe('鱼小应 <noreply@example.com>')
    expect(headers.get('to')).toBe('<student@school.edu.cn>')
    expect(headers.get('subject')).toStartWith('=?UTF-8?B?')
    expect(decodeHeader(headers.get('subject') ?? '')).toBe(mail.subject)
    expect(headers.get('message-id')).toMatch(/^<[^@>]+@example\.com>$/)
    expect(headers.get('mime-version')).toBe('1.0')
    expect(Number.isNaN(Date.parse(headers.get('date') ?? ''))).toBe(false)

    expect(parts.map((part) => part.head)).toEqual([
      'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64',
      'Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64',
    ])
    for (const part of parts) {
      for (const line of part.body.trim().split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
    }
    expect(unb64(parts[0]?.body ?? '')).toBe(mail.text.replace(/\n/g, '\r\n'))
    expect(unb64(parts[1]?.body ?? '')).toBe(mail.html.replace(/\n/g, '\r\n'))
    await waitFor(() => fake?.closedConnections() === 1)
  })

  test('只宣告 LOGIN 时走 AUTH LOGIN 两步', async () => {
    fake = startFakeSmtp({ auth: 'LOGIN' })
    await transportFor(fake.port).send(mail)
    expect(fake.commands.slice(1, 4)).toEqual([
      'AUTH LOGIN',
      b64('noreply@example.com'),
      b64('not-a-real-password'),
    ])
  })

  test('5xx 回复：抛错只带阶段与状态码，不回显收件人；连接被关闭', async () => {
    fake = startFakeSmtp({ reject: { RCPT: '550 5.1.1 <student@school.edu.cn>: user unknown' } })
    const error = await transportFor(fake.port)
      .send(mail)
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : ''
    expect(message).toBe('SMTP RCPT TO 失败 (550)')
    expect(message).not.toContain('student@school.edu.cn')
    expect(fake.commands).not.toContain('DATA')
    await waitFor(() => fake?.closedConnections() === 1)
  })

  test('服务器无响应：总超时后失败并关闭连接', async () => {
    fake = startFakeSmtp({ silent: true })
    await expect(transportFor(fake.port, 200).send(mail)).rejects.toThrow('SMTP 投递超时')
    await waitFor(() => fake?.closedConnections() === 1)
  })

  test('DATA 已 250 接收而 QUIT 无回复：按成功返回，不等满总超时', async () => {
    fake = startFakeSmtp({ quitSilent: true })
    const started = Date.now()
    await transportFor(fake.port, 5_000).send(mail)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(fake.messages).toHaveLength(1)
    await waitFor(() => fake?.closedConnections() === 1)
  })

  test('永不结束的多行回复超过上限即失败，不无限攒内存', async () => {
    fake = startFakeSmtp({ ehloFlood: true })
    await expect(transportFor(fake.port).send(mail)).rejects.toThrow('SMTP 回复过长')
    await waitFor(() => fake?.closedConnections() === 1)
  })

  test('收件地址带 CRLF 直接拒绝（不建连）；主题里的 CRLF 被 encoded-word 吃掉', async () => {
    fake = startFakeSmtp()
    const transport = transportFor(fake.port)
    await expect(
      transport.send({ ...mail, to: 'student@school.edu.cn\r\nBcc: evil@example.org' }),
    ).rejects.toThrow('SMTP 收件地址格式非法')
    expect(fake.connections()).toBe(0)

    await transport.send({ ...mail, subject: 'hi\r\nBcc: evil@example.org' })
    const headerBlock = (fake.messages[0] ?? '').split('\r\n\r\n')[0] ?? ''
    expect(headerBlock).not.toContain('Bcc:')
  })

  test('SMTP_FROM 格式非法时装配即失败', () => {
    for (const from of [
      '鱼小应 noreply-at-example.com',
      '鱼小应 <a..b@example.com>',
      '鱼小应 <.a@example.com>',
      '鱼小应 <a@a.-b.com>',
    ]) {
      expect(() =>
        createSmtpTransport({
          host: '127.0.0.1',
          port: 25,
          secure: false,
          user: 'u',
          pass: 'p',
          from,
        }),
      ).toThrow('SMTP_FROM')
    }
  })
})
