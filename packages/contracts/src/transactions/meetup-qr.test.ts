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
