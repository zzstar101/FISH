import { describe, expect, test } from 'bun:test'
import {
  avatarMime,
  mimeFromImageType,
  NICKNAME_MAX,
  nicknameError,
  profileUpdateBody,
} from '../src/features/profile/avatar'

/**
 * 编辑资料页的纯逻辑（#86 B）。
 *
 * 页面本身要起 Taro / 微信环境，这里只钉三件能在 bun 里跑的事：头像 mime 怎么判、
 * 昵称什么算不合法、这次保存该不该发请求（以及发什么）。
 */

describe('mimeFromImageType —— 信系统给的格式，不信文件名', () => {
  test('四种白名单格式都认，大小写与空白不影响', () => {
    expect(mimeFromImageType('jpeg')).toBe('image/jpeg')
    expect(mimeFromImageType('jpg')).toBe('image/jpeg')
    expect(mimeFromImageType(' PNG ')).toBe('image/png')
    expect(mimeFromImageType('webp')).toBe('image/webp')
  })

  test('白名单外的格式（gif）与空值返回 null', () => {
    expect(mimeFromImageType('gif')).toBeNull()
    expect(mimeFromImageType('')).toBeNull()
    expect(mimeFromImageType(null)).toBeNull()
    expect(mimeFromImageType(undefined)).toBeNull()
  })
})

describe('avatarMime —— 系统格式优先，后缀兜底', () => {
  test('真机临时文件常没有后缀：靠 getImageInfo.type 判出来', () => {
    expect(avatarMime('png', 'wxfile://tmp_1234567890')).toBe('image/png')
  })

  test('拿不到 type 时退回后缀', () => {
    expect(avatarMime(null, 'wxfile://tmp_abc.jpeg')).toBe('image/jpeg')
    expect(avatarMime(undefined, 'wxfile://tmp_abc.webp')).toBe('image/webp')
  })

  test('两边都不认才返回 null（页面据此报「仅支持 JPG / PNG / WebP」）', () => {
    expect(avatarMime(null, 'wxfile://tmp_abc')).toBeNull()
    expect(avatarMime('gif', 'wxfile://tmp_abc.gif')).toBeNull()
  })
})

describe('nicknameError —— 前端预检，服务端才是权威', () => {
  test('空 / 纯空白都要提示输入', () => {
    expect(nicknameError('')).toBe('请输入昵称')
    expect(nicknameError('   ')).toBe('请输入昵称')
  })

  test('trim 后 1–20 字合法（边界 20 通过、21 报错）', () => {
    expect(nicknameError('鱼')).toBeNull()
    expect(nicknameError('鱼'.repeat(NICKNAME_MAX))).toBeNull()
    expect(nicknameError('鱼'.repeat(NICKNAME_MAX + 1))).toBe(`昵称最多 ${NICKNAME_MAX} 个字`)
  })

  test('首尾空格不占额度', () => {
    expect(nicknameError(`  ${'鱼'.repeat(NICKNAME_MAX)}  `)).toBeNull()
  })
})

describe('profileUpdateBody —— 没改动就别发必然 422 的空对象', () => {
  test('昵称与头像都没变 → null（页面提示「没有需要保存的修改」）', () => {
    expect(profileUpdateBody('小明', { nickname: '小明', avatarObjectKey: null })).toBeNull()
  })

  test('昵称只是首尾多空格 → 也算没改', () => {
    expect(profileUpdateBody('小明', { nickname: ' 小明 ', avatarObjectKey: null })).toBeNull()
  })

  test('只改昵称 → 只带 nickname（trim 后提交）', () => {
    expect(profileUpdateBody('小明', { nickname: ' 小红 ', avatarObjectKey: null })).toEqual({
      nickname: '小红',
    })
  })

  test('只换头像 → 只带 avatarObjectKey', () => {
    expect(
      profileUpdateBody('小明', { nickname: '小明', avatarObjectKey: 'listings/u1/a.jpg' }),
    ).toEqual({ avatarObjectKey: 'listings/u1/a.jpg' })
  })

  test('两样都改 → 两个字段一起带', () => {
    expect(
      profileUpdateBody('小明', { nickname: '小红', avatarObjectKey: 'listings/u1/a.jpg' }),
    ).toEqual({ nickname: '小红', avatarObjectKey: 'listings/u1/a.jpg' })
  })
})
