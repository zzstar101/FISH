import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { buildMeetupQrPayload, parseMeetupQrPayload } from './meetup-qr'

const txId = encodePublicId(PUBLIC_ID_PREFIX.transaction, '01990000-0000-7000-8000-0000000000a1')
const token = 'q3fJ8kLp2wRtY9uBv1cDxy'

describe('meetup-qr payload', () => {
  test('build → parse 往返一致（API 构造 / 小程序解析同一格式）', () => {
    const payload = buildMeetupQrPayload(txId, token)
    expect(payload).toBe(`fish://meetup/redeem?tx=${txId}&t=${token}`)
    expect(parseMeetupQrPayload(payload)).toEqual({ transactionId: txId, token })
  })

  test('不依赖全局 URL：weapp 的 TaroURL 对 fish:// 构造即抛，解析仍须成功（#536）', () => {
    const payload = buildMeetupQrPayload(txId, token)
    const realUrl = globalThis.URL
    // 复刻 TaroURL 在小程序里的行为：只认 http(s)://，其余构造直接抛 TypeError。
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      writable: true,
      value: class {
        constructor() {
          throw new TypeError("Failed to construct 'URL': Invalid URL")
        }
      },
    })
    try {
      expect(parseMeetupQrPayload(payload)).toEqual({ transactionId: txId, token })
      // 同样的环境下，非本应用内容也必须安全返回 null，而不是把异常抛给扫码回调。
      expect(parseMeetupQrPayload('https://example.com/pay?tx=1')).toBeNull()
      expect(parseMeetupQrPayload('random text')).toBeNull()
    } finally {
      Object.defineProperty(globalThis, 'URL', {
        configurable: true,
        writable: true,
        value: realUrl,
      })
    }
  })

  test('畸形百分号转义不抛（扫码结果是不可信输入）', () => {
    expect(parseMeetupQrPayload(`fish://meetup/redeem?tx=%E0%A4%A&t=${token}`)).toBeNull()
    expect(parseMeetupQrPayload('fish://meetup/redeem?tx=x&t=%')).toBeNull()
  })

  test('非本应用内容 / 畸形字段一律拒绝（扫描结果不可信）', () => {
    // 外部二维码（URL、任意文本、6 位码）
    expect(parseMeetupQrPayload('https://example.com/pay?tx=1')).toBeNull()
    expect(parseMeetupQrPayload('random text')).toBeNull()
    expect(parseMeetupQrPayload('123456')).toBeNull()
    // 前缀对但字段坏：tx 非规范 TypeID / token 含非 base64url / 缺 token
    expect(parseMeetupQrPayload(`fish://meetup/redeem?tx=not-a-uuid&t=${token}`)).toBeNull()
    expect(parseMeetupQrPayload(`fish://meetup/redeem?tx=${txId}&t=${token};rm -rf`)).toBeNull()
    expect(parseMeetupQrPayload(`fish://meetup/redeem?tx=${txId}`)).toBeNull()
    // host 被改成钓鱼域
    expect(parseMeetupQrPayload(`fish://evil/redeem?tx=${txId}&t=${token}`)).toBeNull()
  })

  test('build 侧对畸形输入 fail fast（签发是服务端可信路径）', () => {
    expect(() => buildMeetupQrPayload('nope', token)).toThrow()
    expect(() => buildMeetupQrPayload(txId, 'bad token with space')).toThrow()
  })
})
