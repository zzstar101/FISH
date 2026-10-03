import { expect, test } from 'bun:test'
import { checkExplicitConstraints, scoreConstrainedMatch } from './constraints'

const wish = (description: string) => ({ keyword: '闲置设备', description })
const listing = (title: string, description = '') => ({ title, description })

test('单对象排除与直接否定的必需条件：读取完整描述并判断极性，不按商品名分支', () => {
  expect(checkExplicitConstraints(listing('金属'), wish('不要金属的')).state).toBe('contradicted')
  expect(checkExplicitConstraints(listing('第二册'), wish('不接受第二册')).state).toBe(
    'contradicted',
  )
  expect(
    checkExplicitConstraints(listing('网络设备', '不支持自定义协议'), wish('必须支持自定义协议'))
      .state,
  ).toBe('contradicted')
  expect(
    checkExplicitConstraints(listing('支架', '不是金属，是木质'), wish('不要金属')).state,
  ).toBe('satisfied')
})

test('明确正向满足、普通偏好与不介意/不要求不能误作排除', () => {
  expect(
    checkExplicitConstraints(listing('设备', '支持自定义协议'), wish('必须支持自定义协议')).state,
  ).toBe('satisfied')
  expect(
    checkExplicitConstraints(listing('金属支架'), wish('金属最好，不介意金属，不要求木质')).state,
  ).toBe('unconstrained')
  expect(
    checkExplicitConstraints(listing('不仅支持有线，还支持无线'), wish('不要有线')).state,
  ).toBe('unknown')
  expect(checkExplicitConstraints(listing('设备', '支持有线'), wish('不要有线')).state).toBe(
    'contradicted',
  )
})

test('引用、双重否定、假设和作用范围不清不构成硬拦截证据', () => {
  for (const text of [
    '包装标注“金属”',
    '不是不支持金属',
    '如果需要金属可另外购买',
    '不支持塑料或金属',
  ]) {
    expect(checkExplicitConstraints(listing('支架', text), wish('不要金属')).state).toBe('unknown')
  }
  expect(checkExplicitConstraints(listing('金属支架', '不是金属'), wish('不要金属')).state).toBe(
    'unknown',
  )
})

test('别名、不提及、复合约束与英文词边界未证实时保持未知，不猜商品兼容性', () => {
  expect(
    checkExplicitConstraints(listing('设备', '不支持甲品牌平板'), wish('必须支持tablet手写')).state,
  ).toBe('unknown')
  expect(checkExplicitConstraints(listing('ipadOS 软件'), wish('不要ipad')).state).toBe('unknown')
  expect(checkExplicitConstraints(listing('普通设备'), wish('只要金属或木质')).state).toBe(
    'unknown',
  )
  expect(checkExplicitConstraints(listing('普通设备'), wish('只要不是金属')).state).toBe('unknown')
})

test('不确定陈述、疑问和未解释的后置否定都保持未知，v1/v2 原始分不受影响', () => {
  const uncertain = [
    '是否磁吸尚未确认',
    '可能是磁吸，待核实',
    '磁吸功能不支持',
    '磁吸功能尚不确定',
    '磁吸吗？',
    '未必磁吸',
    '未经核实磁吸',
    '无需磁吸也可以充电',
  ]
  for (const description of uncertain) {
    const facts = { title: '充电底座', description, category: 'OTHER' as const, priceCents: 100 }
    const request = {
      keyword: '充电底座',
      description: '不要磁吸',
      category: 'OTHER' as const,
      budgetMaxCents: 100,
      acceptSimilar: true,
    }
    expect(checkExplicitConstraints(facts, request).state).toBe('unknown')
    for (const semantic of [null, { similarity: 1 }]) {
      expect(scoreConstrainedMatch(facts, request, semantic).score).toBe(100)
    }
  }
})

test('疑问里的不是后缀不构成否定证据；直接陈述不是仍会拒绝必需条件', () => {
  const request = {
    keyword: '支架',
    description: '只要金属',
    category: 'OTHER' as const,
    budgetMaxCents: 100,
    acceptSimilar: true,
  }
  for (const description of ['不知道是不是金属', '是不是金属', '不清楚是不是金属']) {
    const facts = { title: '支架', description, category: 'OTHER' as const, priceCents: 100 }
    expect(checkExplicitConstraints(facts, request).state).toBe('unknown')
    for (const semantic of [null, { similarity: 1 }])
      expect(scoreConstrainedMatch(facts, request, semantic).score).toBe(100)
  }
  const denied = {
    title: '支架',
    description: '不是金属',
    category: 'OTHER' as const,
    priceCents: 100,
  }
  expect(checkExplicitConstraints(denied, request).state).toBe('contradicted')
  for (const semantic of [null, { similarity: 1 }])
    expect(scoreConstrainedMatch(denied, request, semantic).score).toBe(0)
})

test('无问号的疑问助词在肯定/否定之后均是未知，不能把原分归零', () => {
  const pairs = [
    { description: '不是金属吗', requirement: '只要金属' },
    { description: '支持金属吗', requirement: '不要金属' },
    { description: '不是金属么', requirement: '只要金属' },
    { description: '支持金属呢', requirement: '不要金属' },
    { description: '设备支持金属吧', requirement: '不要金属' },
  ]
  for (const pair of pairs) {
    const facts = {
      title: '支架',
      description: pair.description,
      category: 'OTHER' as const,
      priceCents: 100,
    }
    const request = {
      keyword: '支架',
      description: pair.requirement,
      category: 'OTHER' as const,
      budgetMaxCents: 100,
      acceptSimilar: true,
    }
    expect(checkExplicitConstraints(facts, request).state).toBe('unknown')
    for (const semantic of [null, { similarity: 1 }])
      expect(scoreConstrainedMatch(facts, request, semantic).score).toBe(100)
  }
})

test('简单肯定/否定必须覆盖完整分句，未解释的后置条件和范围不产生冲突', () => {
  const pairs = [
    { statement: '不支持蓝牙连接的话可以退货', requirement: '必须支持蓝牙连接' },
    { statement: '不支持蓝牙连接以外的连接方式', requirement: '必须支持蓝牙连接' },
    { statement: '支持蓝牙连接的话可以退货', requirement: '不要蓝牙连接' },
    { statement: '支持蓝牙连接以外的连接方式', requirement: '不要蓝牙连接' },
    { statement: '设备支持蓝牙连接或其他方式', requirement: '不要蓝牙连接' },
  ]
  for (const pair of pairs) {
    const request = {
      keyword: '键盘',
      description: pair.requirement,
      category: 'DIGITAL' as const,
      budgetMaxCents: 100,
      acceptSimilar: true,
    }
    for (const field of ['title', 'description'] as const) {
      const facts = {
        title: '办公键盘',
        description: '',
        category: 'DIGITAL' as const,
        priceCents: 100,
        [field]: field === 'title' ? `${pair.statement}键盘` : pair.statement,
      }
      expect(checkExplicitConstraints(facts, request).state).toBe('unknown')
      for (const semantic of [null, { similarity: 1 }])
        expect(scoreConstrainedMatch(facts, request, semantic).score).toBe(100)
    }
  }
  for (const pair of [
    { statement: '不支持蓝牙连接', requirement: '必须支持蓝牙连接' },
    { statement: '设备支持蓝牙连接', requirement: '不要蓝牙连接' },
  ]) {
    const facts = {
      title: '办公键盘',
      description: pair.statement,
      category: 'DIGITAL' as const,
      priceCents: 100,
    }
    const request = {
      keyword: '键盘',
      description: pair.requirement,
      category: 'DIGITAL' as const,
      budgetMaxCents: 100,
      acceptSimilar: true,
    }
    expect(checkExplicitConstraints(facts, request).state).toBe('contradicted')
    for (const semantic of [null, { similarity: 1 }])
      expect(scoreConstrainedMatch(facts, request, semantic).score).toBe(0)
  }
})

test('标题不享有肯定证据特权：未解释的标题前后文保留unknown及v1/v2原分', () => {
  for (const title of [
    '蓝牙连接以外的连接方式可用的键盘',
    '蓝牙连接的话可以退货的键盘',
    '除蓝牙连接外其他方式可用的键盘',
    '蓝牙连接或其他方式的键盘',
  ]) {
    const facts = { title, description: '', category: 'DIGITAL' as const, priceCents: 100 }
    const request = {
      keyword: '键盘',
      description: '不要蓝牙连接',
      category: 'DIGITAL' as const,
      budgetMaxCents: 100,
      acceptSimilar: true,
    }
    expect(checkExplicitConstraints(facts, request).state).toBe('unknown')
    for (const semantic of [null, { similarity: 1 }])
      expect(scoreConstrainedMatch(facts, request, semantic).score).toBe(100)
  }
})

test('收紧后的标题边界不猜复合命名属性，安全退化保留原分', () => {
  for (const [title, keyword, literal] of [
    ['二手金属支架', '支架', '金属'],
    ['教材第二册', '教材', '第二册'],
    ['微软有线鼠标', '鼠标', '有线'],
  ] as const) {
    const facts = { title, description: '', category: 'OTHER' as const, priceCents: 100 }
    const request = {
      keyword,
      description: `不要${literal}`,
      category: 'OTHER' as const,
      budgetMaxCents: 100,
      acceptSimilar: true,
    }
    expect(checkExplicitConstraints(facts, request).state).toBe('unknown')
    for (const semantic of [null, { similarity: 1 }])
      expect(scoreConstrainedMatch(facts, request, semantic).score).toBe(100)
  }
})

test('未知不扣分；确认冲突在 v1/v2 都归零，保留原始分与有限原因码', () => {
  const facts = {
    ...listing('闲置设备', '不支持自定义协议'),
    category: 'OTHER' as const,
    priceCents: 100,
  }
  const strictWish = {
    ...wish('必须支持自定义协议'),
    category: 'OTHER' as const,
    budgetMaxCents: 100,
    acceptSimilar: true,
  }
  for (const semantic of [null, { similarity: 1 }]) {
    const blocked = scoreConstrainedMatch(facts, strictWish, semantic)
    expect(blocked.score).toBe(0)
    expect(blocked.rawScore).toBe(100)
    expect(blocked.constraint.reasons).toEqual(['required_literal_denied'])
    expect(blocked.constraintPolicyVersion).toBe(1)
    expect(
      scoreConstrainedMatch(facts, { ...strictWish, description: '必须支持另一协议' }, semantic)
        .score,
    ).toBe(100)
  }
})
