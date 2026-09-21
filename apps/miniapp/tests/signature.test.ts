import { describe, expect, mock, test } from 'bun:test'

/**
 * 个性签名存储（#127 review 应修项）—— 锁住两条**验收点**：
 * 1. **按账号隔离**：A 的签名不能出现在 B 名下（换账号场景）；
 * 2. **失败如实回传**：存储读写失败不能假装成功 / 让页面打挂。
 *
 * 为什么用 `mock.module`：`signature.ts` 必须 `import Taro`，而 Bun 下加载真 Taro 会抛
 * `ENABLE_INNER_HTML is not defined`。这里在导入被测模块**之前**用内存 Map 顶替存储。
 */
const store = new Map<string, unknown>()
let throwOnRead = false
let throwOnWrite = false

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => {
      if (throwOnRead) throw new Error('storage read failed')
      return store.get(key) ?? ''
    },
    setStorageSync: (key: string, data: unknown) => {
      if (throwOnWrite) throw new Error('storage write failed')
      store.set(key, data)
    },
    removeStorageSync: (key: string) => {
      store.delete(key)
    },
  },
}))

const { readSignature, saveSignature } = await import('../src/features/profile/signature')

const ALAN = 'u-alan'
const LIN = 'u-lin'

describe('个性签名存储', () => {
  test('按账号分键：A 的签名不会出现在 B 名下', () => {
    saveSignature(ALAN, '诚信面交，先验货后付款')
    saveSignature(LIN, '只在图书馆交易')

    expect(readSignature(ALAN)).toBe('诚信面交，先验货后付款')
    expect(readSignature(LIN)).toBe('只在图书馆交易')
  })

  test('没设置过的账号读回 null（页面据此渲染占位）', () => {
    expect(readSignature('u-nobody')).toBeNull()
  })

  test('空输入 / 纯空白 = 清除，读回 null', () => {
    saveSignature(ALAN, '先留着')
    expect(saveSignature(ALAN, '   ')).toBe(true)
    expect(readSignature(ALAN)).toBeNull()

    saveSignature(ALAN, '先留着')
    expect(saveSignature(ALAN, '')).toBe(true)
    expect(readSignature(ALAN)).toBeNull()
  })

  test('存多行时原样保留（只取首行是展示层的事）', () => {
    saveSignature(ALAN, '第一行\n第二行')

    expect(readSignature(ALAN)).toBe('第一行\n第二行')
  })

  test('写失败回传 false，不假装保存成功', () => {
    throwOnWrite = true
    expect(saveSignature(ALAN, '写不进去')).toBe(false)
    throwOnWrite = false
  })

  test('读失败按「没设置」处理，不把页面打挂', () => {
    throwOnRead = true
    expect(readSignature(ALAN)).toBeNull()
    throwOnRead = false
  })
})
