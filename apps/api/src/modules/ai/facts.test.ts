import { describe, expect, test } from 'bun:test'
import { addsUnknownFacts, extractFacts } from './facts'

describe('事实令牌抽取', () => {
  test('数字 + 紧邻单位，全角与空白归一化后等价', () => {
    expect([...extractFacts('九成新 128 GB 500元')]).toEqual(['9成', '128g', '500元'])
    expect([...extractFacts('１２８Ｇ')]).toEqual(['128g'])
    expect([...extractFacts('1,000元')]).toEqual(['1000元'])
  })

  test('中文数字按量级换算，纯数字序列按位拼接', () => {
    expect([...extractFacts('两万')]).toEqual(['20000'])
    expect([...extractFacts('五千块')]).toEqual(['5000块'])
    expect([...extractFacts('十二成新')]).toEqual(['12成'])
    expect([...extractFacts('二零二五年版')]).toEqual(['2025'])
  })

  test('歧义汉字里的数字不算事实（一起 / 一年 / 一共）', () => {
    expect([...extractFacts('一起买 一年保修 一共三件')]).toEqual([])
  })

  test('未列入单位的字符退化为只比数字（少判不误杀）', () => {
    expect([...extractFacts('1.5米')]).toEqual(['1.5'])
    expect([...extractFacts('3个')]).toEqual(['3'])
    // 单字中文数字 + 未识别单位不抽：宁可少判，也要避免 `一起/一切/一共` 里的 `一` 变成 1
    expect([...extractFacts('三件 一个月')]).toEqual([])
  })

  test('脱敏标记不计入事实（标记里的计数不是模型新增的数字）', () => {
    expect([...extractFacts('电话 [fish-phone-1] 容量 [fish-card-2]')]).toEqual([])
  })
})

describe('候选是否新增事实', () => {
  test('设计测试矩阵要求的两对不许误杀', () => {
    expect(addsUnknownFacts('成色九成新，容量128G', '成色9成新，容量128 GB')).toBe(false)
    expect(addsUnknownFacts('成色九成新', '9成新')).toBe(false)
    expect(addsUnknownFacts('容量 128 GB', '容量128G')).toBe(false)
  })

  test('候选新增原价 500元 → 丢弃', () => {
    expect(addsUnknownFacts('全新未拆封 128G', '全新未拆封 128G，原价500元')).toBe(true)
  })

  test('同一个数字换了值 → 丢弃', () => {
    expect(addsUnknownFacts('售价 1000元', '售价 800元')).toBe(true)
  })

  test('候选里的脱敏标记还原回来不算新增事实', () => {
    expect(addsUnknownFacts('容量128G，联系13812345678', '容量128G，联系[fish-phone-1]')).toBe(
      false,
    )
  })

  test('同义单位改写（元 ↔ 块）会被判为新增：设计 §11-R4 已接受该误杀，待 filtered_count 观察', () => {
    expect(addsUnknownFacts('原价 500元', '原价 500块')).toBe(true)
  })

  test('基线可传多项（标题 + 描述）：引用标题里的型号数字不算新增', () => {
    // 真实上游踩过：只拿描述当基线时，候选写了标题里的 "罗技 K380" 就带出令牌 380 → 三条全丢。
    expect(
      addsUnknownFacts(['罗技 K380 键盘', '九成新，功能正常'], '罗技 K380 键盘，九成新，功能正常'),
    ).toBe(false)
    expect(addsUnknownFacts('九成新，功能正常', '罗技 K380 键盘，九成新，功能正常')).toBe(true)
  })

  test('原文没有数字时，候选出现任何数字都算新增', () => {
    expect(addsUnknownFacts('几乎全新', '九成新')).toBe(true)
    expect(addsUnknownFacts('几乎全新', '几乎全新，用了1个月')).toBe(true)
  })
})
