import { describe, expect, test } from 'bun:test'
import { isChooseMediaCancel } from '../src/features/upload/choose-error'

/**
 * `pickPhotos` 只允许吞掉「用户取消」。
 *
 * 回归背景：这里曾把 `chooseMedia` 的**所有** reject 都当成取消静默返回空数组，
 * 于是相册权限被拒 / 相机异常 / 平台失败在界面上表现成「点了选图什么都没发生」。
 */
describe('isChooseMediaCancel —— 只认显式取消', () => {
  test('errMsg 含 cancel（大小写不敏感）才算取消', () => {
    expect(isChooseMediaCancel({ errMsg: 'chooseMedia:fail cancel' })).toBe(true)
    expect(isChooseMediaCancel({ errMsg: 'chooseMedia:fail Cancel' })).toBe(true)
    expect(isChooseMediaCancel({ errMsg: 'chooseMedia:fail user cancel' })).toBe(true)
  })

  test('权限被拒 / 相机异常一律不算取消（必须冒泡成可展示的错误）', () => {
    expect(isChooseMediaCancel({ errMsg: 'chooseMedia:fail auth deny' })).toBe(false)
    expect(isChooseMediaCancel({ errMsg: 'chooseMedia:fail camera error' })).toBe(false)
    expect(isChooseMediaCancel({ errMsg: 'chooseMedia:fail' })).toBe(false)
  })

  test('形状不像错误对象时判不出来，按「不是取消」处理（宁可多报错，不静默吞）', () => {
    expect(isChooseMediaCancel(undefined)).toBe(false)
    expect(isChooseMediaCancel(null)).toBe(false)
    expect(isChooseMediaCancel('cancel')).toBe(false)
    expect(isChooseMediaCancel({})).toBe(false)
    // 只有 errMsg 是判据：别的字段写着 cancel 也不算
    expect(isChooseMediaCancel({ code: 'cancel' })).toBe(false)
    expect(isChooseMediaCancel({ errMsg: 123 })).toBe(false)
  })
})
