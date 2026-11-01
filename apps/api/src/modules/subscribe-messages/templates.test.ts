import { describe, expect, test } from 'bun:test'
import {
  chatDeliveryContent,
  formatDateCST,
  formatTimeCST,
  notificationDeliveryContent,
  PHRASE_MAX_CHARS,
  THING_MAX_CHARS,
  truncatePhrase,
  truncateThing,
} from './templates'

/**
 * 模板映射层（#462）的纯函数用例。
 *
 * 这一层的错误只会在微信侧以 `47003`（参数不合法）出现，那时本地已经分不清"我们写错了"
 * 与"平台故障"，所以字段长度、时间格式、事件 → 文案这三个映射必须逐个钉住。
 */

const AT = new Date('2026-11-01T02:30:00.000Z') // = 2026-11-01 10:30 Asia/Shanghai

describe('truncateThing / truncatePhrase', () => {
  test('不超过上限时原样返回', () => {
    expect(truncateThing('全新机械键盘')).toBe('全新机械键盘')
    expect(truncateThing('a'.repeat(THING_MAX_CHARS))).toHaveLength(THING_MAX_CHARS)
    expect(truncatePhrase('已完成')).toBe('已完成')
  })

  test('超出上限时截断并补省略号，总长仍在上限内', () => {
    const long = '超长的商品标题一二三四五六七八九十甲乙丙丁'
    const truncated = truncateThing(long)
    expect([...truncated]).toHaveLength(THING_MAX_CHARS)
    expect(truncated.endsWith('…')).toBe(true)
    // 保留的是前 19 个字符 + 省略号，不是从头截 20 个（那样末尾会是省略号以外的东西）
    expect(truncated.slice(0, -1)).toBe([...long].slice(0, THING_MAX_CHARS - 1).join(''))
  })

  test('按码点而不是 UTF-16 码元截断：代理对不会被切一半', () => {
    // 5 个 emoji = 10 个 UTF-16 码元；旧写法（slice）会把第 4 个 emoji 切成孤立代理对。
    const emoji = '🎉🎉🎉🎉🎉'
    expect([...truncatePhrase(emoji)]).toHaveLength(PHRASE_MAX_CHARS)
    // 结果里不能出现孤立代理对：每个码点都应是完整的（没有 0xD800-0xDFFF 单独成字）
    for (const char of truncatePhrase(emoji)) {
      const code = char.codePointAt(0) ?? 0
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false)
    }
  })

  test('换行 / 制表等空白压成单个空格', () => {
    expect(truncateThing('  两行\n标题\t带空白  ')).toBe('两行 标题 带空白')
  })
})

describe('formatTimeCST / formatDateCST', () => {
  test('time 类用北京时间 YYYY-MM-DD HH:mm', () => {
    expect(formatTimeCST(AT)).toBe('2026-11-01 10:30')
  })

  test('date 类用北京时间 YYYY-MM-DD，且跨零点按北京时间算日期', () => {
    expect(formatDateCST(AT)).toBe('2026-11-01')
    // UTC 还是 10-31 的 17:00，北京时间已经是 11-01 01:00
    expect(formatDateCST(new Date('2026-10-31T17:00:00.000Z'))).toBe('2026-11-01')
  })
})

describe('notificationDeliveryContent', () => {
  const base = {
    createdAt: AT,
    listingTitle: '九成新自行车',
    transactionId: 'txn_0199a0000000700080000000000a',
    conversationId: 'cnv_0199a0000000700080000000000b',
    listingId: 'lst_0199a0000000700080000000000c',
  }

  test.each([
    ['PROPOSED', '待接受'],
    ['ACCEPTED', '已接受'],
    ['REJECTED', '已拒绝'],
    ['CONFIRMED', '已确认'],
    ['COMPLETED', '已完成'],
    ['CANCELLED', '已取消'],
  ] as const)('TX 事件 %s → 订单状态「%s」', (event, phrase) => {
    const content = notificationDeliveryContent({ ...base, type: 'TX', payload: { event } })
    expect(content?.kind).toBe('TX')
    expect(content?.data.phrase3).toBe(phrase)
    expect(content?.data.time8).toBe('2026-11-01 10:30')
    expect(content?.data.thing6).toBe('九成新自行车')
    // 交易详情优先
    expect(content?.page).toBe(
      'pkg-trade/pages/transaction-meetup/index?id=txn_0199a0000000700080000000000a',
    )
  })

  test.each([
    ['FILED', '纠纷处理中'],
    ['WITHDRAWN', '纠纷已撤回'],
    ['RESOLVED', '纠纷已处理'],
  ] as const)('DISPUTE 事件 %s → 订单状态「%s」', (disputeEvent, phrase) => {
    const content = notificationDeliveryContent({
      ...base,
      type: 'DISPUTE',
      payload: { disputeEvent },
    })
    expect(content?.kind).toBe('TX')
    expect(content?.data.phrase3).toBe(phrase)
  })

  test('TX 没有交易时退到会话页；两者都没有就不投递', () => {
    const toConversation = notificationDeliveryContent({
      ...base,
      type: 'TX',
      payload: { event: 'PROPOSED' },
      transactionId: null,
    })
    expect(toConversation?.page).toBe(
      'pkg-social/pages/conversation/index?id=cnv_0199a0000000700080000000000b',
    )

    const nowhere = notificationDeliveryContent({
      ...base,
      type: 'TX',
      payload: { event: 'PROPOSED' },
      transactionId: null,
      conversationId: null,
    })
    expect(nowhere).toBeNull()
  })

  test('事件缺失 / 值集外：不猜文案，宁可不投递', () => {
    expect(notificationDeliveryContent({ ...base, type: 'TX', payload: {} })).toBeNull()
    expect(
      notificationDeliveryContent({
        ...base,
        type: 'DISPUTE',
        payload: { disputeEvent: undefined },
      }),
    ).toBeNull()
  })

  test('MODERATION → REVIEW 模板，跳商品详情', () => {
    const content = notificationDeliveryContent({
      ...base,
      type: 'MODERATION',
      payload: { outcome: 'APPROVED' },
    })
    expect(content?.kind).toBe('REVIEW')
    expect(content?.data).toEqual({
      thing2: '九成新自行车',
      phrase1: '审核通过',
      date3: '2026-11-01',
      thing7: '点击查看商品详情',
    })
    expect(content?.page).toBe(
      'pkg-browse/pages/listing-detail/index?id=lst_0199a0000000700080000000000c',
    )
  })

  test('MODERATION 缺商品 id：拼不出页面，不投递', () => {
    expect(
      notificationDeliveryContent({
        ...base,
        type: 'MODERATION',
        payload: { outcome: 'REJECTED' },
        listingId: null,
      }),
    ).toBeNull()
  })

  test('ACCOUNT/VERIFICATION → REVIEW 模板，跳认证页', () => {
    const content = notificationDeliveryContent({
      ...base,
      type: 'ACCOUNT',
      payload: { subject: 'VERIFICATION', outcome: 'REJECTED' },
    })
    expect(content?.kind).toBe('REVIEW')
    expect(content?.data.phrase1).toBe('认证未通过')
    expect(content?.page).toBe('pkg-auth/pages/verify/index')
  })

  test('ACCOUNT 的非认证主题不在首批：不猜文案', () => {
    expect(
      notificationDeliveryContent({ ...base, type: 'ACCOUNT', payload: { outcome: 'APPROVED' } }),
    ).toBeNull()
  })

  test('MATCH 不在首批（Owner 明确排除求购匹配）', () => {
    expect(
      notificationDeliveryContent({ ...base, type: 'MATCH', payload: { matchId: 'mtc_x' } }),
    ).toBeNull()
  })

  test('商品标题缺失时给中性占位，绝不发空 thing', () => {
    const content = notificationDeliveryContent({
      ...base,
      type: 'MODERATION',
      payload: { outcome: 'APPROVED' },
      listingTitle: null,
    })
    expect(content?.data.thing2).toBe('商品审核')
  })
})

describe('chatDeliveryContent', () => {
  test('消息内容固定「你有一条新消息」，不推正文', () => {
    const content = chatDeliveryContent({
      conversationId: 'cnv_0199a0000000700080000000000b',
      senderNickname: '林一',
      listingTitle: '九成新自行车',
      messageCreatedAt: AT,
    })
    expect(content.kind).toBe('CHAT')
    expect(content.data).toEqual({
      thing4: '林一',
      thing2: '你有一条新消息',
      thing28: '九成新自行车',
      time3: '2026-11-01 10:30',
    })
    expect(content.page).toBe(
      'pkg-social/pages/conversation/index?id=cnv_0199a0000000700080000000000b',
    )
  })

  test('昵称 / 商品名缺失时用占位串（thing 不能为空）', () => {
    const content = chatDeliveryContent({
      conversationId: 'cnv_0199a0000000700080000000000b',
      senderNickname: '',
      listingTitle: '',
      messageCreatedAt: AT,
    })
    expect(content.data.thing4).toBe('对方')
    expect(content.data.thing28).toBe('会话商品')
  })
})
