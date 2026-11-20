/**
 * 本地 provider 与工厂的测试（#228）。
 *
 * 本地 transport 只用于开发/测试，但它的**判定语义**必须和腾讯 transport 一致：
 * 图片不审内容时进人工队列（REVIEW）而不是放行；全空白输入不是通过。
 */
import { describe, expect, test } from 'bun:test'
import { loadContentModerationEnv } from '@fish/shared/env'
import { MODERATION_RULE_VERSION } from '../rules'
import { createContentModerationProvider } from './factory'
import { createLocalContentModerationProvider, LOCAL_IMAGE_NOT_AUDITED } from './local'
import { aggregateModerationDecision, ContentModerationError } from './types'

const loadImage = async () => ({ bytes: new Uint8Array([1, 2, 3]) })

describe('本地 provider', () => {
  test('文本走本地词表：违禁词 BLOCK、引流词 REVIEW、正常文案 ALLOW', async () => {
    const provider = createLocalContentModerationProvider()
    expect(provider.transport).toBe('local')

    const blocked = await provider.moderateText({
      dataId: 'lst_1',
      fields: [{ field: 'title', value: '出售违禁品' }],
    })
    const reviewed = await provider.moderateText({
      dataId: 'lst_2',
      fields: [{ field: 'description', value: '闲置转让，加微信详聊' }],
    })
    const allowed = await provider.moderateText({
      dataId: 'lst_3',
      fields: [{ field: 'title', value: '八成新山地车' }],
    })

    expect(blocked.decision).toBe('BLOCK')
    expect(blocked.provider).toBe('LOCAL')
    expect(blocked.policyVersion).toBe(MODERATION_RULE_VERSION)
    expect(blocked.fields[0]).toMatchObject({
      field: 'title',
      decision: 'BLOCK',
      subLabel: 'PROHIBITED_CONTENT',
      label: null,
      score: null,
      requestId: null,
    })
    expect(reviewed.decision).toBe('REVIEW')
    expect(reviewed.fields[0]?.subLabel).toBe('EXTERNAL_CONTACT')
    expect(allowed.decision).toBe('ALLOW')
    expect(allowed.fields[0]?.subLabel).toBeNull()
  })

  // #694 M6：公开 UGC 用独立的 `publicContent` 字段。联系方式是公开场景的灰区规则，
  // 不能因为私聊允许（content 字段跳过 EXTERNAL_CONTACT）而在留言/评价里被放过。
  test('公开 UGC（publicContent 字段）的引流词判 REVIEW，私聊 content 仍放行', async () => {
    const provider = createLocalContentModerationProvider()
    const ugc = await provider.moderateText({
      dataId: 'cmt_1',
      fields: [{ field: 'publicContent', value: '闲置出售，加微信详聊' }],
    })
    const chat = await provider.moderateText({
      dataId: 'chat_2',
      fields: [{ field: 'content', value: '闲置出售，加微信详聊' }],
    })
    expect(ugc.decision).toBe('REVIEW')
    expect(ugc.fields[0]).toMatchObject({ field: 'publicContent', decision: 'REVIEW' })
    expect(ugc.fields[0]?.subLabel).toBe('PUBLIC_EXTERNAL_CONTACT')
    expect(chat.decision).toBe('ALLOW')
  })

  // #694 M1：聊天正文以 `content` 字段送审。旧实现只认 title/description，会把聊天文本
  // 静默判成 ALLOW —— 这里钉住 content 真的进了词表。
  test('聊天正文（content 字段）同样经过词表，不被静默放行', async () => {
    const provider = createLocalContentModerationProvider()
    const blocked = await provider.moderateText({
      dataId: 'chat_1',
      fields: [{ field: 'content', value: '出售违禁品' }],
    })
    expect(blocked.decision).toBe('BLOCK')
    expect(blocked.fields[0]).toMatchObject({ field: 'content', decision: 'BLOCK' })
    // 审计只落脱敏命中词，不落正文。
    expect(blocked.fields[0]?.maskedTerms).toEqual(['违*品'])

    const allowed = await provider.moderateText({
      dataId: 'chat_2',
      fields: [{ field: 'content', value: '在吗' }],
    })
    expect(allowed.decision).toBe('ALLOW')

    // #694 M1：EXTERNAL_CONTACT 是商品文案的引流规则，不能套到私聊——
    // 私聊里交换联系方式是正常行为，不得因此被判 REVIEW。
    const contact = await provider.moderateText({
      dataId: 'chat_3',
      fields: [{ field: 'content', value: '方便的话加微信：fish2026，我把图发你' }],
    })
    expect(contact.decision).toBe('ALLOW')
  })

  test('多字段聚合取最高风险，字段判定各自独立', async () => {
    const provider = createLocalContentModerationProvider()

    const result = await provider.moderateText({
      dataId: 'lst_4',
      fields: [
        { field: 'title', value: '八成新山地车' },
        { field: 'description', value: '加微信详聊' },
      ],
    })

    expect(result.decision).toBe('REVIEW')
    expect(result.fields.map((item) => [item.field, item.decision])).toEqual([
      ['title', 'ALLOW'],
      ['description', 'REVIEW'],
    ])
  })

  test('全空白输入不是通过：按入参错误拒绝', async () => {
    const provider = createLocalContentModerationProvider()

    try {
      await provider.moderateText({ dataId: 'lst_5', fields: [{ field: 'title', value: ' ' }] })
      throw new Error('预期调用失败，但成功返回了')
    } catch (error) {
      expect(error).toBeInstanceOf(ContentModerationError)
      expect((error as ContentModerationError).reason).toBe('invalid_input')
    }
  })

  test('图片不审内容 → 一律 REVIEW（进人工队列），绝不 ALLOW', async () => {
    const provider = createLocalContentModerationProvider()

    const result = await provider.moderateImage({
      dataId: 'img_1',
      objectKey: 'listings/a.jpg',
    })

    expect(result.decision).toBe('REVIEW')
    expect(result.suggestion).toBe('Review')
    expect(result.reasonCode).toBe(LOCAL_IMAGE_NOT_AUDITED)
    expect(result.contentDigest).toBeNull()
    expect(result.transport).toBe('local')
  })
})

describe('决策聚合', () => {
  test('取最高风险 BLOCK > REVIEW > ALLOW；空数组是「没有结论」而不是放行', () => {
    expect(aggregateModerationDecision(['ALLOW', 'REVIEW'])).toBe('REVIEW')
    expect(aggregateModerationDecision(['ALLOW', 'BLOCK', 'REVIEW'])).toBe('BLOCK')
    expect(aggregateModerationDecision(['ALLOW'])).toBe('ALLOW')
    expect(() => aggregateModerationDecision([])).toThrow(ContentModerationError)
  })

  test('未知判定值不降级为 ALLOW（来自 DB / 反序列化的字符串不能绕过聚合）', () => {
    try {
      aggregateModerationDecision(['BOGUS' as never])
      throw new Error('预期调用失败，但成功返回了')
    } catch (error) {
      expect(error).toBeInstanceOf(ContentModerationError)
      expect((error as ContentModerationError).reason).toBe('invalid_input')
      expect((error as ContentModerationError).detail).toBe('decision')
    }
  })
})

describe('provider 工厂', () => {
  test('transport=local → 本地实现，不需要任何腾讯密钥', () => {
    const env = loadContentModerationEnv({ CONTENT_MODERATION_TRANSPORT: 'local' })
    const provider = createContentModerationProvider(env, { loadImage })

    expect(provider.transport).toBe('local')
  })

  test('transport=tencent → 腾讯实现（不发起真实请求，真实调用需授权环境）', () => {
    const env = loadContentModerationEnv({
      CONTENT_MODERATION_TRANSPORT: 'tencent',
      TENCENT_CLOUD_SECRET_ID: 'id',
      TENCENT_CLOUD_SECRET_KEY: 'key',
      TENCENT_TMS_BIZ_TYPE: 'tms',
      TENCENT_IMS_BIZ_TYPE: 'ims',
      TENCENT_TMS_CHAT_BIZ_TYPE: 'tms-chat',
      TENCENT_IMS_CHAT_BIZ_TYPE: 'ims-chat',
      TENCENT_TMS_UGC_BIZ_TYPE: 'tms-ugc',
    })
    const provider = createContentModerationProvider(env, { loadImage })

    expect(provider.transport).toBe('tencent')
    expect(typeof provider.moderateText).toBe('function')
    expect(typeof provider.moderateImage).toBe('function')
  })
})
