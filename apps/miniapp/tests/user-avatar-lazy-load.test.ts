import { expect, mock, test } from 'bun:test'

/**
 * 卖家头像懒加载的**接线**（#595）。
 *
 * 需求第三项：商品卡的封面早就有 `lazyLoad`，卖家头像没有 —— 一屏几十张卡就是几十个
 * 头像请求同时发。修法是给 `UserAvatar` 一个可选的 `lazyLoad`，由商品卡传下去。
 *
 * 两条都不能少：
 * 1. 传了 `lazyLoad` 就真的落到 `Image` 上（否则等于没改）；
 * 2. **不传时行为不变** —— 头像在设置页、详情页、聊天等十几处复用，默认改成懒加载
 *    会让首屏之外该立刻出现的头像变成空圈。
 *
 * 尺寸 / 占位 / 失败回退都不该被这次改动碰到，所以这里同时钉住默认头像与 onError 分支。
 */

let slots: unknown[] = []
let cursor = 0
mock.module('react', () => ({
  useState: <T>(initial: T | (() => T)) => {
    const index = cursor++
    if (!(index in slots)) {
      slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial
    }
    return [
      slots[index],
      (next: T | ((previous: T) => T)) => {
        slots[index] =
          typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next
      },
    ]
  },
}))
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props })
mock.module('react/jsx-runtime', () => ({ jsx, jsxs: jsx, Fragment: 'Fragment' }))
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: jsx, Fragment: 'Fragment' }))
mock.module('@tarojs/components', () => ({ View: 'View', Image: 'Image' }))

const { default: UserAvatar } = await import('../src/components/user-avatar')

type Element = { props: Record<string, unknown> }

/** 取渲染结果里的第一张 Image（真实头像或默认头像） */
function image(tree: unknown): Element {
  const element = tree as Element
  const children = element.props.children as Element
  return children
}

function mount(props: Record<string, unknown>): unknown {
  slots = []
  cursor = 0
  return UserAvatar(props as never)
}

/** 保留 hook 槽位再渲一次（模拟 setState 之后的重渲染） */
function rerender(props: Record<string, unknown>): unknown {
  cursor = 0
  return UserAvatar(props as never)
}

const REAL = 'https://cdn.example.com/avatar.png'

test('商品卡传了 lazyLoad：真实头像的 Image 上真的开了懒加载', () => {
  const img = image(mount({ src: REAL, className: 'pcard__avatar', lazyLoad: true }))
  expect(img.props.lazyLoad).toBe(true)
  expect(img.props.src).toBe(REAL)
})

test('不传 lazyLoad 时行为不变：其它十几个调用点不该被顺带改成懒加载', () => {
  const img = image(mount({ src: REAL }))
  expect(img.props.lazyLoad).toBeUndefined()
})

test('默认头像（没有 src）不受影响：仍是包内资源、不懒加载', () => {
  const img = image(mount({ src: null, lazyLoad: true }))
  expect(img.props.src).not.toBe(REAL)
  expect(img.props.lazyLoad).toBeUndefined()
})

test('失败回退仍在：图挂了换成默认头像，占位不空', () => {
  const props = { src: REAL }
  const img = image(mount(props))
  const onError = img.props.onError
  expect(typeof onError).toBe('function')
  ;(onError as () => void)()
  const after = image(rerender(props))
  expect(after.props.src).not.toBe(REAL)
})
