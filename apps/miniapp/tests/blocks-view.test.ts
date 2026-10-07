/**
 * 拉黑域纯函数单测（#473）。`features/blocks/view.ts` 不 import Taro，bun test 直接跑。
 * 页面接线（哪些函数被哪些页面调用）由 `tests/blocks-wiring.test.ts` 源码文本钉住。
 */
import { describe, expect, test } from 'bun:test'
import {
  blockConfirmModal,
  blockEntryView,
  describeBlockFailure,
} from '../src/features/blocks/view'

/** 与 `lib/request` 的 ApiError 同形状（三个特征），但不 import 它（那会拖进 Taro）。 */
function apiErrorLike(code: string, status: number): Error & { code: string; status: number } {
  return Object.assign(new Error('服务端文案'), { name: 'ApiError', code, status })
}

describe('describeBlockFailure（域内错误码 → 行内文案）', () => {
  test('USER_NOT_FOUND / CANNOT_BLOCK_SELF 各有稳定文案', () => {
    expect(describeBlockFailure(apiErrorLike('USER_NOT_FOUND', 404))).toBe('用户不存在或不可见')
    expect(describeBlockFailure(apiErrorLike('CANNOT_BLOCK_SELF', 422))).toBe('不能拉黑自己')
  })

  test('域外错误（网络 / 未识别码 / 非 ApiError）一律「操作失败，请重试」', () => {
    expect(describeBlockFailure(new Error('boom'))).toBe('操作失败，请重试')
    expect(describeBlockFailure(apiErrorLike('SOMETHING_ELSE', 500))).toBe('操作失败，请重试')
    expect(describeBlockFailure(undefined)).toBe('操作失败，请重试')
  })

  test('形状不全的仿冒对象不按 ApiError 判（name/code/status 三特征缺一不可）', () => {
    const partial = Object.assign(new Error('x'), { code: 'USER_NOT_FOUND', status: 404 })
    expect(describeBlockFailure(partial)).toBe('操作失败，请重试')
  })
})

describe('blockEntryView（他人主页入口 UI 状态）', () => {
  test('读到状态之前：不渲染（绝不猜一个状态画上去；读失败由页面保持 null）', () => {
    expect(blockEntryView({ read: null, pending: false }).visible).toBe(false)
  })

  test('未拉黑 → 「拉黑该用户」；已拉黑 → 「解除拉黑」', () => {
    const notBlocked = blockEntryView({ read: { blocked: false }, pending: false })
    expect(notBlocked).toEqual({
      visible: true,
      label: '拉黑该用户',
      busy: false,
      blocked: false,
    })
    const blocked = blockEntryView({ read: { blocked: true }, pending: false })
    expect(blocked.label).toBe('解除拉黑')
    expect(blocked.blocked).toBe(true)
  })

  test('写入中：busy + 按当前状态给「拉黑中…/解除中…」，不翻转语义', () => {
    expect(blockEntryView({ read: { blocked: false }, pending: true })).toEqual({
      visible: true,
      label: '拉黑中…',
      busy: true,
      blocked: false,
    })
    expect(blockEntryView({ read: { blocked: true }, pending: true }).label).toBe('解除中…')
  })
})

describe('blockConfirmModal（拉黑确认弹窗文案）', () => {
  test('标题带昵称；后果说明覆盖双向拦截 / 交易不受影响 / 可解除', () => {
    const modal = blockConfirmModal('张三')
    expect(modal.title).toBe('拉黑「张三」？')
    expect(modal.confirmText).toBe('确认拉黑')
    expect(modal.content).toContain('双方都无法再发消息')
    expect(modal.content).toContain('新建会话')
    expect(modal.content).toContain('面交流程不受影响')
    expect(modal.content).toContain('可随时解除')
  })
})
