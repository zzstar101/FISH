import { describe, expect, test } from 'bun:test'
import { createRedactor } from './redact'

describe('脱敏', () => {
  test('七类标识符各替换为对应标记，同一类内计数递增', () => {
    const redactor = createRedactor()

    expect(redactor.redact('电话 13812345678')).toBe('电话 [fish-phone-1]')
    expect(redactor.redact('另一个 13912345678')).toBe('另一个 [fish-phone-2]')
    expect(redactor.redact('证件 11010119900307123X')).toBe('证件 [fish-id-1]')
    expect(redactor.redact('卡号 6222021234567890123')).toBe('卡号 [fish-card-1]')
    expect(redactor.redact('邮箱 abc@gzasc.edu.cn')).toBe('邮箱 [fish-mail-1]')
    expect(redactor.redact('加微信 abc_12345')).toBe('加[fish-contact-1]')
    expect(redactor.redact('住 12号楼')).toBe('住 [fish-addr-1]')
    expect(redactor.redact('看 https://example.com/x')).toBe('看 [fish-url-1]')
  })

  test('手机号的分隔与全角变体同样命中', () => {
    expect(createRedactor().redact('138-1234-5678')).toBe('[fish-phone-1]')
    expect(createRedactor().redact('138 1234 5678')).toBe('[fish-phone-1]')
    expect(createRedactor().redact('１３８１２３４５６７８')).toBe('[fish-phone-1]')
  })

  test('联系方式与链接的常见写法都命中', () => {
    expect(createRedactor().redact('QQ 1234567')).toBe('[fish-contact-1]')
    expect(createRedactor().redact('+v: hello123')).toBe('[fish-contact-1]')
    expect(createRedactor().redact('看 www.example.com')).toBe('看 [fish-url-1]')
    expect(createRedactor().redact('看 taobao.com/abc')).toBe('看 [fish-url-1]')
  })

  test('身份证优先于手机号：18 位里那截 1[3-9] 开头的片段不会被手机号规则切走', () => {
    // 若 phone 规则排在 id 之前，这里会变成 [fish-phone-1] + 残留数字，两者都还原不回来。
    expect(createRedactor().redact('11010119900307123X')).toBe('[fish-id-1]')
  })

  test('不误伤正文里的数字与单位', () => {
    const redactor = createRedactor()
    expect(redactor.redact('九成新 128G 500元 2室1厅 1.5米 K380')).toBe(
      '九成新 128G 500元 2室1厅 1.5米 K380',
    )
    expect(redactor.redacted).toBe(false)
  })
})

describe('回填', () => {
  test('标记原样找回时还原为用户原文', () => {
    const redactor = createRedactor()
    const marked = redactor.redact('电话 138-1234-5678，微信 abc_12345')
    expect(marked).toBe('电话 [fish-phone-1]，[fish-contact-1]')

    expect(redactor.restore(`${marked} 全新未拆`)).toEqual({
      text: '电话 138-1234-5678，微信 abc_12345 全新未拆',
      lost: false,
    })
  })

  test('丢一个标记就整条降级为类型化提示语（不按顺序猜）', () => {
    const redactor = createRedactor()
    const marked = redactor.redact('电话 13812345678，微信 abc_12345')
    const damaged = marked.replace('[fish-contact-1]', '')

    expect(redactor.restore(damaged)).toEqual({
      text: '电话 （你的联系方式已被移除），',
      lost: true,
    })
  })

  test('模型自造的标记（不是本实例发出的）同样整条降级', () => {
    const redactor = createRedactor()
    const marked = redactor.redact('电话 13812345678')

    expect(redactor.restore(`${marked} 也可以加 [fish-phone-9]`)).toEqual({
      text: '电话 （你的联系方式已被移除） 也可以加 （你的联系方式已被移除）',
      lost: true,
    })
  })

  test('没有标记时原样返回且不降级', () => {
    expect(createRedactor().restore('无标记的普通描述')).toEqual({
      text: '无标记的普通描述',
      lost: false,
    })
  })
})
