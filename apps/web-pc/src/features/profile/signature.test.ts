import { describe, expect, test } from 'bun:test'
import { prepareSignatureInput } from './signature'

describe('prepareSignatureInput（#179 契约语义的端上落地）', () => {
  test('与原值一致（含原值为 null 的空输入）→ unchanged，不发签名写入', () => {
    expect(prepareSignatureInput('热爱二手书', '热爱二手书')).toEqual({ status: 'unchanged' })
    expect(prepareSignatureInput('', null)).toEqual({ status: 'unchanged' })
    expect(prepareSignatureInput('  ', null)).toEqual({ status: 'unchanged' })
  })

  test('trim 后与原值一致 → unchanged', () => {
    expect(prepareSignatureInput('  热爱二手书  ', '热爱二手书')).toEqual({ status: 'unchanged' })
  })

  test('原值非空、输入只有空白 → ok 空串（刻意的清空语义，不是 unchanged）', () => {
    expect(prepareSignatureInput('   ', '热爱二手书')).toEqual({ status: 'ok', value: '' })
  })

  test('超长 → error，消息与契约 SignatureSchema 同源', () => {
    const result = prepareSignatureInput('好'.repeat(201), null)
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.message).toBe('个性签名最多 200 字')
  })

  test('正常输入 trim 后透传，保留内部换行（契约允许换行存原文）', () => {
    expect(prepareSignatureInput('  第一行\n第二行  ', null)).toEqual({
      status: 'ok',
      value: '第一行\n第二行',
    })
  })
})
