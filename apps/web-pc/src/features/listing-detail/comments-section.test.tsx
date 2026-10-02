import { expect, test } from 'bun:test'
import { canDeleteComment } from './comments-section'

const ME = 'usr_01jc000000e00800000000000a'
const OTHER = 'usr_01jc000000e00800000000000b'

/** 判据只读 `author.id`，其余字段与归属无关 —— 这里给最小形状即可。 */
function entry(authorId: string): { author: { id: string } } {
  return { author: { id: authorId } }
}

test('只有自己的留言/回复才有删除入口', () => {
  expect(canDeleteComment(entry(ME), ME)).toBe(true)
  expect(canDeleteComment(entry(OTHER), ME)).toBe(false)
})

test('会话未恢复（viewerId 为 null）时谁都不给删除入口', () => {
  expect(canDeleteComment(entry(ME), null)).toBe(false)
})
