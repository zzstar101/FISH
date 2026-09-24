import { describe, expect, test } from 'bun:test'
import { requestSellEdit, takeSellEdit } from '../src/features/listing/edit-target'
import {
  parsePriceToCents,
  sellBlockMessage,
  sellBusyText,
  sellFieldErrorsFromDetails,
  sellSubmitOutcome,
  validateSellForm,
} from '../src/pages/sell/form'

/**
 * 发布页的纯判定（#74 / #89 sell 行真实接线）。
 *
 * 组件接线（什么时候调哪个函数、把结果渲染到哪）没有单测 —— 本仓 tests/ 只有纯逻辑
 * 测试，没有 Taro 组件渲染基建（与 `home-list-state.test.ts` 同一说明）。
 */

describe('parsePriceToCents —— 价格字符串 → 整数分', () => {
  test('合法输入按分取整，支持 0 与两位小数', () => {
    expect(parsePriceToCents('0', false)).toBe(0)
    expect(parsePriceToCents('16', false)).toBe(1600)
    expect(parsePriceToCents('12.3', false)).toBe(1230)
    expect(parsePriceToCents('12.34', false)).toBe(1234)
  })

  test('非法输入返回 null，而不是 NaN 进请求体', () => {
    for (const bad of ['', '   ', 'abc', '12.345', '-1', '1e3', '12.'])
      expect(parsePriceToCents(bad, false)).toBeNull()
  })

  test('0 元送恒为 0：价格框已锁定，不该再读它的值', () => {
    expect(parsePriceToCents('', true)).toBe(0)
    expect(parsePriceToCents('999', true)).toBe(0)
  })
})

describe('validateSellForm —— 提交前本地校验', () => {
  const base = {
    title: '罗技 K380 键盘',
    description: '宿舍用了一学期',
    priceCents: 16000,
    category: 'DIGITAL' as const,
    imageCount: 1,
  }

  test('字段齐全时放行', () => {
    expect(validateSellForm(base)).toBeNull()
  })

  test('逐项挡下缺字段，并给出第一条文案', () => {
    expect(validateSellForm({ ...base, title: 'a' })).toBe('标题至少 2 个字')
    expect(validateSellForm({ ...base, description: '   ' })).toBe('请填写描述')
    expect(validateSellForm({ ...base, priceCents: null })).toBe('请填写正确价格')
    expect(validateSellForm({ ...base, category: null })).toBe('请选择分类')
    expect(validateSellForm({ ...base, imageCount: 0 })).toBe('至少上传 1 张图片')
  })
})

describe('sellFieldErrorsFromDetails —— 服务端字段级错误落位', () => {
  test('契约字段名映射到页面输入区（objectKeys → 图片、priceCents → 价格）', () => {
    expect(
      sellFieldErrorsFromDetails([
        { field: 'title', message: '标题包含平台禁止发布的内容' },
        { field: 'description', message: '描述包含平台禁止发布的内容' },
      ]),
    ).toEqual({
      title: '标题包含平台禁止发布的内容',
      description: '描述包含平台禁止发布的内容',
    })
    expect(
      sellFieldErrorsFromDetails([{ field: 'objectKeys', message: '图片尚未上传完成' }]),
    ).toEqual({ images: '图片尚未上传完成' })
    expect(
      sellFieldErrorsFromDetails([{ field: 'priceCents', message: '0 元送时价格必须为 0' }]),
    ).toEqual({ price: '0 元送时价格必须为 0' })
  })

  test('认不出的字段不猜，也不凭空造出页面没有的错误块', () => {
    expect(sellFieldErrorsFromDetails(undefined)).toEqual({})
    expect(sellFieldErrorsFromDetails([])).toEqual({})
    expect(sellFieldErrorsFromDetails([{ field: 'sellerId', message: 'x' }])).toEqual({})
  })

  test('category 与分类选择区同名，必须落位（AI 润色的 422 恰好只有 title / description / category）', () => {
    expect(sellFieldErrorsFromDetails([{ field: 'category', message: '分类不合法' }])).toEqual({
      category: '分类不合法',
    })
  })

  test('同字段只留第一条', () => {
    const errors = sellFieldErrorsFromDetails([
      { field: 'title', message: '第一条' },
      { field: 'title', message: '第二条' },
      { field: 'description', message: '描述' },
    ])
    expect(errors.title).toBe('第一条')
  })
})

describe('sellBlockMessage —— 页头提示点名字段，不报计数', () => {
  test('按命中字段给文案；两个内容字段都命中时并列', () => {
    expect(sellBlockMessage({ title: 'x' })).toBe('标题中有违规内容')
    expect(sellBlockMessage({ description: 'x' })).toBe('描述中有违规内容')
    expect(sellBlockMessage({ title: 'x', description: 'y' })).toBe('标题和描述中有违规内容')
  })

  test('只有价格/图片这类非内容字段时退到通用文案，不谎称标题或描述有问题', () => {
    expect(sellBlockMessage({ price: '0 元送时价格必须为 0' })).toBe('商品内容未通过审核')
    expect(sellBlockMessage({})).toBe('商品内容未通过审核')
  })
})

describe('sellBusyText —— 提交中遮罩文案', () => {
  test('只区分保存与发布（图片是选中即上传，提交阶段没有上传进度）', () => {
    expect(sellBusyText({ editing: false })).toBe('正在发布…')
    expect(sellBusyText({ editing: true })).toBe('正在保存…')
  })
})

describe('sellSubmitOutcome —— 提交成功后落地', () => {
  test('REVIEW 留在发布页说「已提交审核」，其余跳商品详情', () => {
    expect(sellSubmitOutcome({ moderationStatus: 'REVIEW' })).toBe('pending-review')
    expect(sellSubmitOutcome({ moderationStatus: 'APPROVED' })).toBe('detail')
    // 公开/他人视角恒 null；发布响应是本人视角，正常 ALLOW 时到这里
    expect(sellSubmitOutcome({ moderationStatus: null })).toBe('detail')
  })
})

describe('edit-target —— Tab 页的编辑交接', () => {
  test('取一次就失效：之后从底栏进「出物」不会再掉进上一次的编辑态', () => {
    expect(takeSellEdit()).toBeNull()
    requestSellEdit('listing-1')
    expect(takeSellEdit()).toBe('listing-1')
    expect(takeSellEdit()).toBeNull()
  })

  test('后一次请求覆盖前一次（连续点两件商品的编辑）', () => {
    requestSellEdit('listing-1')
    requestSellEdit('listing-2')
    expect(takeSellEdit()).toBe('listing-2')
  })
})
