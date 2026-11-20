import { describe, expect, test } from 'bun:test'
import { RENTAL_MAX_DAYS, RENTAL_MIN_DAYS } from '@fish/contracts/rentals/schema'
import {
  fieldErrorsFromDetails,
  isRentalEligibilityError,
  parseDays,
  parseMoneyToCents,
  RENTAL_FORM_DEFAULTS,
  rentalPublishErrorText,
  validateRentalForm,
} from '@/pkg-rental/pages/rental-publish/form'

/**
 * 出租发布页的纯判定（#706）。这些函数决定「屏幕该显示什么」与「能不能发请求」，
 * 组件里没有第二条实现 —— 所以这里覆盖到就等于覆盖了页面的校验行为。
 */

describe('parseMoneyToCents', () => {
  test('整数与两位小数都按分换算', () => {
    expect(parseMoneyToCents('25')).toBe(2500)
    expect(parseMoneyToCents('25.5')).toBe(2550)
    expect(parseMoneyToCents('25.05')).toBe(2505)
    expect(parseMoneyToCents('0')).toBe(0)
  })

  test('空串 / 非法格式 / 三位小数返回 null', () => {
    expect(parseMoneyToCents('')).toBeNull()
    expect(parseMoneyToCents('   ')).toBeNull()
    expect(parseMoneyToCents('abc')).toBeNull()
    expect(parseMoneyToCents('1.234')).toBeNull()
    expect(parseMoneyToCents('-5')).toBeNull()
  })
})

describe('parseDays', () => {
  test('正整数天', () => {
    expect(parseDays('1')).toBe(1)
    expect(parseDays('90')).toBe(90)
  })

  test('0 / 负数 / 小数 / 空串都不是合法天数', () => {
    expect(parseDays('0')).toBeNull()
    expect(parseDays('-1')).toBeNull()
    expect(parseDays('1.5')).toBeNull()
    expect(parseDays('')).toBeNull()
  })
})

describe('validateRentalForm', () => {
  const valid = {
    title: '出租 iPad',
    description: '含配件',
    dailyPriceCents: 2500,
    depositCents: 0,
    minDays: 1,
    maxDays: 7,
    imageCount: 1,
  }

  test('完整合法表单通过', () => {
    expect(validateRentalForm(valid)).toBeNull()
  })

  test('押金为 0 合法（免押）', () => {
    expect(validateRentalForm({ ...valid, depositCents: 0 })).toBeNull()
  })

  test('缺图片 / 缺标题 / 缺描述都拒', () => {
    expect(validateRentalForm({ ...valid, imageCount: 0 })).toContain('图片')
    expect(validateRentalForm({ ...valid, title: ' ' })).toContain('标题')
    expect(validateRentalForm({ ...valid, description: '' })).toContain('描述')
  })

  test('日租价必须为正（0 元出租不是有效业务）', () => {
    expect(validateRentalForm({ ...valid, dailyPriceCents: 0 })).toContain('日租价')
    expect(validateRentalForm({ ...valid, dailyPriceCents: null })).toContain('日租价')
  })

  test('押金未填（null）要拒，但 0 不算未填', () => {
    expect(validateRentalForm({ ...valid, depositCents: null })).toContain('押金')
    expect(validateRentalForm({ ...valid, depositCents: 0 })).toBeNull()
  })

  test('租期上下界与相对关系', () => {
    expect(validateRentalForm({ ...valid, minDays: RENTAL_MIN_DAYS - 1 })).toContain('最短租期')
    expect(validateRentalForm({ ...valid, maxDays: RENTAL_MAX_DAYS + 1 })).toContain('最长租期')
    expect(validateRentalForm({ ...valid, minDays: 10, maxDays: 3 })).toContain('不能短于')
  })

  test('报的是第一条错误，顺序与页面字段顺序一致', () => {
    // 同时缺标题与图片：标题在前。
    expect(validateRentalForm({ ...valid, title: '', imageCount: 0 })).toContain('标题')
  })
})

describe('fieldErrorsFromDetails', () => {
  test('契约字段名映射到页面字段', () => {
    const errors = fieldErrorsFromDetails([
      { field: 'title', message: '标题不合规' },
      { field: 'objectKeys', message: '图片不合规' },
      { field: 'dailyPriceCents', message: '价格不合规' },
      { field: 'depositCents', message: '押金不合规' },
      { field: 'minDays', message: '最短租期不合规' },
      { field: 'maxDays', message: '最长租期不合规' },
      { field: 'rules', message: '规则不合规' },
      { field: 'description', message: '描述不合规' },
    ])
    expect(errors).toEqual({
      title: '标题不合规',
      images: '图片不合规',
      dailyPrice: '价格不合规',
      deposit: '押金不合规',
      minDays: '最短租期不合规',
      maxDays: '最长租期不合规',
      rules: '规则不合规',
      description: '描述不合规',
    })
  })

  test('同字段只留第一条（多条会互相打架）', () => {
    const errors = fieldErrorsFromDetails([
      { field: 'title', message: '第一条' },
      { field: 'title', message: '第二条' },
    ])
    expect(errors.title).toBe('第一条')
  })

  test('认不出的字段与缺 field 的条目都丢弃（不猜）', () => {
    const errors = fieldErrorsFromDetails([
      { field: 'condition', message: '成色不合规' },
      { message: '没有字段名' },
    ])
    expect(errors).toEqual({})
  })

  test('undefined 详情不炸', () => {
    expect(fieldErrorsFromDetails(undefined)).toEqual({})
  })
})

describe('isRentalEligibilityError', () => {
  test('只认 403 + RENTAL_NOT_ELIGIBLE', () => {
    expect(isRentalEligibilityError({ status: 403, code: 'RENTAL_NOT_ELIGIBLE' })).toBe(true)
  })

  test('其它 403（治理限制 / 未绑手机）不算资格问题', () => {
    expect(isRentalEligibilityError({ status: 403, code: 'USER_RESTRICTED' })).toBe(false)
    expect(isRentalEligibilityError({ status: 403, code: 'PHONE_REQUIRED' })).toBe(false)
    // 同码不同状态也不算
    expect(isRentalEligibilityError({ status: 422, code: 'RENTAL_NOT_ELIGIBLE' })).toBe(false)
  })

  test('非对象输入不炸', () => {
    expect(isRentalEligibilityError(null)).toBe(false)
    expect(isRentalEligibilityError('RENTAL_NOT_ELIGIBLE')).toBe(false)
  })
})

describe('rentalPublishErrorText', () => {
  test('已知错误码各有固定说法', () => {
    expect(rentalPublishErrorText({ code: 'RENTAL_NOT_ELIGIBLE' })).toContain('教育邮箱认证')
    expect(rentalPublishErrorText({ code: 'RENTAL_CONTENT_BLOCKED' })).toContain('审核')
    expect(rentalPublishErrorText({ code: 'PHONE_REQUIRED' })).toContain('手机号')
    expect(rentalPublishErrorText({ code: 'USER_RESTRICTED' })).toContain('限制')
    expect(rentalPublishErrorText({ code: 'VALIDATION_FAILED' })).toContain('检查')
  })

  test('未知码与无码都给通用说法，不透传服务端 message', () => {
    expect(rentalPublishErrorText({ code: 'SOMETHING_ELSE' })).toBe('发布失败，请稍后重试')
    expect(rentalPublishErrorText(new Error('raw server message'))).toBe('发布失败，请稍后重试')
  })
})

describe('RENTAL_FORM_DEFAULTS', () => {
  test('默认租期落在平台界内', () => {
    expect(Number(RENTAL_FORM_DEFAULTS.minDays)).toBeGreaterThanOrEqual(RENTAL_MIN_DAYS)
    expect(Number(RENTAL_FORM_DEFAULTS.maxDays)).toBeLessThanOrEqual(RENTAL_MAX_DAYS)
    expect(Number(RENTAL_FORM_DEFAULTS.maxDays)).toBeGreaterThanOrEqual(
      Number(RENTAL_FORM_DEFAULTS.minDays),
    )
  })
})
