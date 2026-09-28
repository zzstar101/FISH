import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TENCENT_CLOUD_REGION,
  loadAiPolishEnv,
  loadContentModerationEnv,
  loadWechatEnv,
} from './env'

describe('loadAiPolishEnv', () => {
  test('stub 只需 transport 与 base_url，没有 apiKey 字段', () => {
    expect(
      loadAiPolishEnv({ AI_POLISH_TRANSPORT: 'stub', AI_POLISH_BASE_URL: 'http://127.0.0.1:8787' }),
    ).toEqual({ transport: 'stub', baseUrl: 'http://127.0.0.1:8787' })
  })

  test('live 三项齐全时返回 base_url / apiKey / model', () => {
    expect(
      loadAiPolishEnv({
        AI_POLISH_TRANSPORT: 'live',
        AI_POLISH_BASE_URL: 'https://api.example.com',
        AI_POLISH_API_KEY: 'sk-not-a-real-key',
        AI_POLISH_MODEL: 'deepseek-flash',
      }),
    ).toEqual({
      transport: 'live',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-not-a-real-key',
      model: 'deepseek-flash',
    })
  })

  test('transport=stub 但缺 base_url 也抛错（stub 是真 HTTP 服务，没有进程内回退）', () => {
    expect(() => loadAiPolishEnv({ AI_POLISH_TRANSPORT: 'stub' })).toThrow(/AI_POLISH_BASE_URL/)
  })

  test('live 缺任一必填项都抛错（逐项验证）', () => {
    const complete = {
      AI_POLISH_TRANSPORT: 'live',
      AI_POLISH_BASE_URL: 'https://api.example.com',
      AI_POLISH_API_KEY: 'sk-not-a-real-key',
      AI_POLISH_MODEL: 'deepseek-flash',
    }
    expect(() => loadAiPolishEnv({ ...complete, AI_POLISH_BASE_URL: undefined })).toThrow(
      /AI_POLISH_BASE_URL/,
    )
    expect(() => loadAiPolishEnv({ ...complete, AI_POLISH_API_KEY: undefined })).toThrow(
      /AI_POLISH_API_KEY/,
    )
    expect(() => loadAiPolishEnv({ ...complete, AI_POLISH_MODEL: undefined })).toThrow(
      /AI_POLISH_MODEL/,
    )
  })

  test('失败信息只出现变量名，不回显密钥值', () => {
    let message = ''
    try {
      loadAiPolishEnv({
        AI_POLISH_TRANSPORT: 'live',
        AI_POLISH_BASE_URL: 'https://api.example.com',
        AI_POLISH_API_KEY: 'sk-not-a-real-key',
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('AI_POLISH_MODEL')
    expect(message).not.toContain('sk-not-a-real-key')
  })

  test('transport 缺失 / 空串 / 非法取值都抛错（无默认值）', () => {
    expect(() => loadAiPolishEnv({})).toThrow(/必须显式设置/)
    expect(() => loadAiPolishEnv({ AI_POLISH_TRANSPORT: '' })).toThrow(/必须显式设置/)
    expect(() => loadAiPolishEnv({ AI_POLISH_TRANSPORT: 'dev' })).toThrow(/必须显式设置/)
  })

  test('全空白的值等于没配：三个值都 trim 后判空', () => {
    // 只判真值会让 `AI_POLISH_BASE_URL='   '` 通过启动，然后每个请求都 503（设计决策 #8 要避免的
    // "配错和没配看起来一样"）。
    expect(() =>
      loadAiPolishEnv({
        AI_POLISH_TRANSPORT: 'live',
        AI_POLISH_BASE_URL: '   ',
        AI_POLISH_API_KEY: 'sk-not-a-real-key',
        AI_POLISH_MODEL: 'deepseek-flash',
      }),
    ).toThrow(/AI_POLISH_BASE_URL/)
    expect(() =>
      loadAiPolishEnv({
        AI_POLISH_TRANSPORT: 'live',
        AI_POLISH_BASE_URL: 'https://api.example.com',
        AI_POLISH_API_KEY: '  ',
        AI_POLISH_MODEL: 'deepseek-flash',
      }),
    ).toThrow(/AI_POLISH_API_KEY/)
    expect(() => loadAiPolishEnv({ AI_POLISH_TRANSPORT: 'stub', AI_POLISH_BASE_URL: ' ' })).toThrow(
      /AI_POLISH_BASE_URL/,
    )
  })

  test('值两侧的空白被 trim 后再返回（key 里带空格会让鉴权永远失败）', () => {
    expect(
      loadAiPolishEnv({
        AI_POLISH_TRANSPORT: 'live',
        AI_POLISH_BASE_URL: ' https://api.example.com/ ',
        AI_POLISH_API_KEY: ' sk-not-a-real-key ',
        AI_POLISH_MODEL: ' deepseek-flash ',
      }),
    ).toEqual({
      transport: 'live',
      baseUrl: 'https://api.example.com/',
      apiKey: 'sk-not-a-real-key',
      model: 'deepseek-flash',
    })
  })
})

describe('loadContentModerationEnv', () => {
  test('local 只在非生产环境可用，且不带任何密钥字段', () => {
    expect(
      loadContentModerationEnv({ CONTENT_MODERATION_TRANSPORT: 'local' }, 'development'),
    ).toEqual({ transport: 'local' })
    expect(loadContentModerationEnv({ CONTENT_MODERATION_TRANSPORT: 'local' }, 'test')).toEqual({
      transport: 'local',
    })
  })

  test('生产环境禁止 local：本地词表不是内容安全审核，不静默兜底', () => {
    expect(() =>
      loadContentModerationEnv({ CONTENT_MODERATION_TRANSPORT: 'local' }, 'production'),
    ).toThrow(/CONTENT_MODERATION_TRANSPORT/)
    // `NODE_ENV` 未显式传参时取 `source.NODE_ENV`。
    expect(() =>
      loadContentModerationEnv({ CONTENT_MODERATION_TRANSPORT: 'local', NODE_ENV: 'production' }),
    ).toThrow(/NODE_ENV=production/)
    // 大小写 / 两侧空白变体同样按生产处理：最后一道护栏不能因为拼写就失效。
    for (const nodeEnv of ['Production', 'PRODUCTION', ' production '] as const) {
      expect(() =>
        loadContentModerationEnv({ CONTENT_MODERATION_TRANSPORT: 'local' }, nodeEnv),
      ).toThrow(/NODE_ENV=production/)
    }
  })

  test('transport 无默认值：缺失或非法值都直接失败', () => {
    expect(() => loadContentModerationEnv({})).toThrow(/CONTENT_MODERATION_TRANSPORT/)
    expect(() => loadContentModerationEnv({ CONTENT_MODERATION_TRANSPORT: 'stub' })).toThrow(
      /CONTENT_MODERATION_TRANSPORT/,
    )
    expect(() => loadContentModerationEnv({ CONTENT_MODERATION_TRANSPORT: ' tencent' })).toThrow(
      /CONTENT_MODERATION_TRANSPORT/,
    )
  })

  test('tencent 四项必填，缺任一项都失败（错误信息只报变量名）', () => {
    const complete = {
      CONTENT_MODERATION_TRANSPORT: 'tencent',
      TENCENT_CLOUD_SECRET_ID: 'secret-id-value',
      TENCENT_CLOUD_SECRET_KEY: 'secret-key-value',
      TENCENT_TMS_BIZ_TYPE: 'tms-biz',
      TENCENT_IMS_BIZ_TYPE: 'ims-biz',
    }
    expect(loadContentModerationEnv(complete)).toEqual({
      transport: 'tencent',
      secretId: 'secret-id-value',
      secretKey: 'secret-key-value',
      tmsBizType: 'tms-biz',
      imsBizType: 'ims-biz',
      region: DEFAULT_TENCENT_CLOUD_REGION,
    })

    for (const key of [
      'TENCENT_CLOUD_SECRET_ID',
      'TENCENT_CLOUD_SECRET_KEY',
      'TENCENT_TMS_BIZ_TYPE',
      'TENCENT_IMS_BIZ_TYPE',
    ] as const) {
      const source: Record<string, string | undefined> = { ...complete, [key]: ' ' }
      let message = ''
      try {
        loadContentModerationEnv(source)
      } catch (error) {
        message = (error as Error).message
      }
      // 必须点名「缺的是哪一个」：只报一句「四个都要配」的话，删掉任一变量的校验这个断言仍会通过。
      expect(message).toContain(`缺少 ${key}。`)
      // 密钥值绝不进错误消息（错误信息可能进日志/告警）。
      expect(message).not.toContain('secret-key-value')
      expect(message).not.toContain('secret-id-value')
    }

    // 同时缺两项时两项都要点名。
    expect(() =>
      loadContentModerationEnv({
        ...complete,
        TENCENT_TMS_BIZ_TYPE: ' ',
        TENCENT_IMS_BIZ_TYPE: ' ',
      }),
    ).toThrow(/缺少 TENCENT_TMS_BIZ_TYPE \/ TENCENT_IMS_BIZ_TYPE。/)
  })

  test('值两侧空白被 trim，region 可覆盖且默认 ap-guangzhou', () => {
    const env = loadContentModerationEnv({
      CONTENT_MODERATION_TRANSPORT: 'tencent',
      TENCENT_CLOUD_SECRET_ID: ' id ',
      TENCENT_CLOUD_SECRET_KEY: ' key ',
      TENCENT_TMS_BIZ_TYPE: ' tms ',
      TENCENT_IMS_BIZ_TYPE: ' ims ',
      TENCENT_CLOUD_REGION: ' ap-shanghai ',
    })
    expect(env).toEqual({
      transport: 'tencent',
      secretId: 'id',
      secretKey: 'key',
      tmsBizType: 'tms',
      imsBizType: 'ims',
      region: 'ap-shanghai',
    })
  })
})

describe('loadWechatEnv 的 WECHAT_QR_ENV_VERSION（#197）', () => {
  const live = (extra: Record<string, string>) =>
    loadWechatEnv({
      WECHAT_TRANSPORT: 'live',
      WECHAT_APPID: 'wx123',
      WECHAT_APP_SECRET: 's',
      ...extra,
    })

  test('缺省 release（官方默认，要求小程序已发布）', () => {
    expect(live({})).toEqual({
      transport: 'live',
      appid: 'wx123',
      appSecret: 's',
      qrEnvVersion: 'release',
    })
  })

  test('trial / develop 可显式指定；空白视为未设置', () => {
    expect(live({ WECHAT_QR_ENV_VERSION: 'trial' })).toMatchObject({ qrEnvVersion: 'trial' })
    expect(live({ WECHAT_QR_ENV_VERSION: 'develop' })).toMatchObject({ qrEnvVersion: 'develop' })
    expect(live({ WECHAT_QR_ENV_VERSION: '  ' })).toMatchObject({ qrEnvVersion: 'release' })
  })

  test('拼错的版本名在启动时就炸，而不是等第一次扫码', () => {
    expect(() => live({ WECHAT_QR_ENV_VERSION: 'dev' })).toThrow('WECHAT_QR_ENV_VERSION')
  })

  test('设置即校验：off / stub 下的非法取值同样启动失败', () => {
    expect(() => loadWechatEnv({ WECHAT_TRANSPORT: 'off', WECHAT_QR_ENV_VERSION: 'dev' })).toThrow(
      'WECHAT_QR_ENV_VERSION',
    )
    expect(() => loadWechatEnv({ WECHAT_TRANSPORT: 'stub', WECHAT_QR_ENV_VERSION: 'dev' })).toThrow(
      'WECHAT_QR_ENV_VERSION',
    )
  })
})
