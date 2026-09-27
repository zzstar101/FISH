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
    })
    const provider = createContentModerationProvider(env, { loadImage })

    expect(provider.transport).toBe('tencent')
    expect(typeof provider.moderateText).toBe('function')
    expect(typeof provider.moderateImage).toBe('function')
  })
})
