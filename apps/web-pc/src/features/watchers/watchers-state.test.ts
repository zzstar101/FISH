import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import { watchersLoadError } from './api'
import { watchersPanelState } from './watchers-panel-view'

/**
 * 容器的状态推导（#381 审查 medium 修复）。
 *
 * 关键场景是**缓存复用窗口内的 refetch 失败**：`staleTime: 0` 让每次打开弹窗都 refetch，
 * 而商品可能在别的标签页刚被删掉（`DELETE /listings/:id`）——此时手上还有上一份名单，
 * 状态推导必须仍然降级成业务空态，不能拿着陈旧名单装作没事。
 */
function failureOf(error: unknown) {
  return watchersLoadError(error)
}

describe('watchersPanelState', () => {
  test('首屏加载中 → loading', () => {
    expect(watchersPanelState({ pending: true, failure: null, itemCount: 0 })).toBe('loading')
  })

  test('首屏 404 / 403 → 业务空态（不伪装成系统错误）', () => {
    expect(
      watchersPanelState({
        pending: false,
        failure: failureOf(new ApiError('LISTING_NOT_FOUND', 404, '商品不存在')),
        itemCount: 0,
      }),
    ).toBe('listing-missing')
    expect(
      watchersPanelState({
        pending: false,
        failure: failureOf(new ApiError('NOT_LISTING_OWNER', 403, '只能查看自己商品的想要的人')),
        itemCount: 0,
      }),
    ).toBe('not-owner')
  })

  test('refetch 拿到 404 / 403 时，即使手上有旧名单也降级成业务空态', () => {
    expect(
      watchersPanelState({
        pending: false,
        failure: failureOf(new ApiError('LISTING_NOT_FOUND', 404, '商品不存在')),
        itemCount: 3,
      }),
    ).toBe('listing-missing')
    expect(
      watchersPanelState({
        pending: false,
        failure: failureOf(new ApiError('NOT_LISTING_OWNER', 403, '只能查看自己商品的想要的人')),
        itemCount: 3,
      }),
    ).toBe('not-owner')
  })

  test('首屏网络/500 失败 → 可重试错误；refetch 失败则保留已加载名单（数据只是旧一点）', () => {
    const network = failureOf(new TypeError('fetch failed'))
    expect(watchersPanelState({ pending: false, failure: network, itemCount: 0 })).toBe('error')
    expect(watchersPanelState({ pending: false, failure: network, itemCount: 3 })).toBe('ready')
  })

  test('没有失败时按名单是否为空分 ready / empty', () => {
    expect(watchersPanelState({ pending: false, failure: null, itemCount: 0 })).toBe('empty')
    expect(watchersPanelState({ pending: false, failure: null, itemCount: 2 })).toBe('ready')
  })
})
