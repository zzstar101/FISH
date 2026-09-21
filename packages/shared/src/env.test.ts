import { describe, expect, test } from 'bun:test'
import { loadAiPolishEnv } from './env'

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
