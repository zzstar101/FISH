import { describe, expect, test } from 'bun:test'
import { moderationReasonText, rejectionNote } from '../src/features/listing/moderation-reason'

/**
 * 「未通过原因」的呈现判定（Owner 2026-09-28：不过审要在编辑区上方用红字说明原因）。
 *
 * 服务端那个字段是**原始文本**，两种来源混在一起：机器判定写的是规则码
 * （`PROHIBITED_CONTENT` 之类），人工终审写的是管理员填的原话（上限 500 字）。
 * 所以这里最容易做错的是两件事：把规则码直接摆给用户看，以及把一整段原因原样塞进卡片。
 */
describe('moderationReasonText —— 规则码翻人话', () => {
  test('认得的机器规则码翻成人话', () => {
    expect(moderationReasonText('PROHIBITED_CONTENT')).toBe('标题或描述里含平台禁止发布的内容')
    expect(moderationReasonText('LOCAL_IMAGE_NOT_AUDITED')).toBe('图片需要人工复核')
  })

  test('人工终审的原话原样透出（本来就是给人看的）', () => {
    expect(moderationReasonText('标题里有联系方式，请去掉微信号')).toBe(
      '标题里有联系方式，请去掉微信号',
    )
  })

  test('不认识的码原样透出，不编一句可能不对的原因', () => {
    // 宁可给用户看一个英文码（他至少能报给平台），也不要编一句猜的原因让他白改
    expect(moderationReasonText('SOME_NEW_CODE_FROM_SERVER')).toBe('SOME_NEW_CODE_FROM_SERVER')
  })

  test('null / undefined / 空白一律没有文案（卡片不留空行）', () => {
    expect(moderationReasonText(null)).toBeNull()
    expect(moderationReasonText(undefined)).toBeNull()
    expect(moderationReasonText('   ')).toBeNull()
  })

  test('超长原因截断并补省略号（人工终审上限 500 字，卡片只有一行）', () => {
    const long = '这是一段很长的原因'.repeat(10)
    const text = moderationReasonText(long, 10)
    expect(text).toBe(`${long.slice(0, 10)}…`)
    // 截断按**字符**算：中文一个字算一个，不是按字节
    expect(text?.length).toBe(11)
  })

  test('恰好等于上限时不截断（只超出一个字才补省略号）', () => {
    expect(moderationReasonText('1234567890', 10)).toBe('1234567890')
    expect(moderationReasonText('12345678901', 10)).toBe('1234567890…')
  })
})

describe('rejectionNote —— 卡片上那句红字', () => {
  test('带「未通过原因：」前缀：卡片上还有别的说明，光一句话看不出它为什么在这儿', () => {
    expect(rejectionNote('PROHIBITED_CONTENT')).toBe('未通过原因：标题或描述里含平台禁止发布的内容')
  })

  test('没有原因时整块不渲染（返回 null 而不是空壳前缀）', () => {
    expect(rejectionNote(null)).toBeNull()
    expect(rejectionNote('  ')).toBeNull()
  })
})
