import { describe, expect, test } from 'bun:test'
import {
  buildListingEmbeddingText,
  buildWishEmbeddingText,
  contentHashOf,
  EMBEDDING_TEXT_FORMAT_VERSION,
} from './text'

describe('buildListingEmbeddingText', () => {
  test('三个字段齐全时逐行拼接', () => {
    expect(
      buildListingEmbeddingText({
        title: 'AirPods Pro 2 USB-C',
        description: '全新未拆封，支持降噪',
        category: 'ELECTRONICS',
      }),
    ).toBe('标题: AirPods Pro 2 USB-C\n描述: 全新未拆封，支持降噪\n分类: ELECTRONICS')
  })

  test('null / 空串字段整行省略', () => {
    expect(
      buildListingEmbeddingText({ title: '机械键盘', description: null, category: null }),
    ).toBe('标题: 机械键盘')
    expect(buildListingEmbeddingText({ title: '机械键盘', description: '   ', category: '' })).toBe(
      '标题: 机械键盘',
    )
  })

  test('字段各自 trim、CRLF 归一成 LF', () => {
    expect(
      buildListingEmbeddingText({
        title: '  机械键盘  ',
        description: ' 无线\r\n红轴 ',
        category: ' OTHER ',
      }),
    ).toBe('标题: 机械键盘\n描述: 无线\n红轴\n分类: OTHER')
  })
})

describe('buildWishEmbeddingText', () => {
  test('三个字段齐全时逐行拼接', () => {
    expect(
      buildWishEmbeddingText({
        keyword: '苹果降噪耳机',
        description: '预算 1500 以内',
        category: 'ELECTRONICS',
      }),
    ).toBe('需求: 苹果降噪耳机\n描述: 预算 1500 以内\n分类: ELECTRONICS')
  })

  test('分类为 null 写成「不限」而不是省略该行', () => {
    expect(
      buildWishEmbeddingText({ keyword: '苹果降噪耳机', description: null, category: null }),
    ).toBe('需求: 苹果降噪耳机\n分类: 不限')
  })

  test('描述为空但分类不限时同样只保留两行', () => {
    expect(
      buildWishEmbeddingText({ keyword: '  K380 键盘 ', description: '', category: null }),
    ).toBe('需求: K380 键盘\n分类: 不限')
  })
})

describe('contentHashOf', () => {
  test('稳定：同文本两次调用一致，且是 64 位十六进制', () => {
    const text = buildWishEmbeddingText({ keyword: '机械键盘', description: null, category: null })
    const first = contentHashOf(text)

    expect(contentHashOf(text)).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  test('文本不同则指纹不同', () => {
    const base = buildListingEmbeddingText({ title: 'A', description: null, category: null })
    const changed = buildListingEmbeddingText({ title: 'B', description: null, category: null })

    expect(contentHashOf(base)).not.toBe(contentHashOf(changed))
  })

  test('指纹带格式版本前缀：版本变化必然换指纹', () => {
    const text = '标题: A'
    const expected = new Bun.CryptoHasher('sha256')
      .update(`${EMBEDDING_TEXT_FORMAT_VERSION}:${text}`)
      .digest('hex')

    expect(contentHashOf(text)).toBe(expected)
  })

  test('规范化后等价的文本共享指纹（空白差异不算内容变化）', () => {
    const a = buildListingEmbeddingText({ title: '机械键盘', description: null, category: null })
    const b = buildListingEmbeddingText({ title: '  机械键盘 ', description: '  ', category: null })

    expect(contentHashOf(a)).toBe(contentHashOf(b))
  })
})
