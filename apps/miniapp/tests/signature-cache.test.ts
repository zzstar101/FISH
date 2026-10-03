import { describe, expect, test } from 'bun:test'
import {
  reconcileSavedSignature,
  type SavedSignature,
} from '../src/features/profile/signature-cache'

/**
 * 「我的」页签名会话缓存的调和规则。
 *
 * 签名原本只有内联弹窗一个写入者，`savedSig` 缓存优先于服务端快照是安全的；编辑资料页
 * （pages/profile-edit）成为第二个写入者后（保存成功只广播 store），若不调和，页面会
 * 永久显示缓存旧签名、弹窗还会把旧值原样写回服务端。这里钉住调和规则本身。
 */

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'

describe('reconcileSavedSignature —— store 与缓存不一致即采纳 store', () => {
  test('P1 现场：内联保存过 "A"，编辑资料页改成 "B"（store 广播）→ 缓存被采纳为 "B"', () => {
    const prev: SavedSignature = { forUser: U1, text: 'A' }
    expect(reconcileSavedSignature(prev, { id: U1, signature: 'B' })).toEqual({
      forUser: U1,
      text: 'B',
    })
  })

  test('store 清空签名（null）也要采纳，不能让缓存的旧文本压住', () => {
    const prev: SavedSignature = { forUser: U1, text: 'A' }
    expect(reconcileSavedSignature(prev, { id: U1, signature: null })).toEqual({
      forUser: U1,
      text: null,
    })
  })

  test('一致（内联保存后 store 广播同一值）→ 原对象原样返回，不触发多余渲染', () => {
    const prev: SavedSignature = { forUser: U1, text: 'B' }
    expect(reconcileSavedSignature(prev, { id: U1, signature: 'B' })).toBe(prev)
  })

  test('缓存还没保存过（forUser null）→ 不动', () => {
    const prev: SavedSignature = { forUser: null, text: null }
    expect(reconcileSavedSignature(prev, { id: U1, signature: 'B' })).toBe(prev)
  })

  test('换账号：缓存的旧账号值不归 store 新账号管（由按账号分键的既有失效兜住）', () => {
    const prev: SavedSignature = { forUser: U1, text: 'A' }
    expect(reconcileSavedSignature(prev, { id: U2, signature: 'B' })).toBe(prev)
  })
})
