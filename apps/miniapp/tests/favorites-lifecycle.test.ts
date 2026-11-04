import { beforeEach, expect, mock, test } from 'bun:test'
import { MyFavoritesResponseSchema } from '@fish/contracts/favorites/schema'
import { encodePublicId } from '@fish/shared/public-id'

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected test value')
  return value
}

// Execute the real page handlers with a minimal hook host (no renderer dependency).
let slots: unknown[] = []
let cursor = 0
let dirty = false
let effects: Array<() => void> = []
mock.module('react', () => ({
  useState: <T>(initial: T) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = initial
    return [
      slots[index],
      (next: T | ((previous: T) => T)) => {
        const value =
          typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next
        if (!Object.is(value, slots[index])) dirty = true
        slots[index] = value
      },
    ]
  },
  useRef: <T>(initial: T) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  },
  useCallback: <T>(callback: T, deps: unknown[]) => {
    const index = cursor++
    const previous = slots[index] as { callback: T; deps: unknown[] } | undefined
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      slots[index] = { callback, deps }
    }
    return (slots[index] as { callback: T }).callback
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = cursor++
    const previous = slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      effects.push(() => {
        previous?.cleanup?.()
        slots[index] = { deps, cleanup: effect() }
      })
    }
  },
}))
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props })
mock.module('react/jsx-runtime', () => ({ jsx, jsxs: jsx, Fragment: 'Fragment' }))
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: jsx, Fragment: 'Fragment' }))
let didShow = () => {}
let didHide = () => {}
const toasts: string[] = []
const disk = new Map<string, string>()
mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => disk.get(key),
    setStorageSync: (key: string, value: string) => disk.set(key, value),
    removeStorageSync: (key: string) => disk.delete(key),
    showToast: ({ title }: { title: string }) => {
      toasts.push(title)
    },
  },
  useDidShow: (callback: () => void) => {
    didShow = callback
  },
  useDidHide: (callback: () => void) => {
    didHide = callback
  },
  usePageScroll: () => {},
  usePullDownRefresh: () => {},
}))
mock.module('@tarojs/components', () => ({ View: 'View', Text: 'Text', Image: 'Image' }))
mock.module('@/components/auth-required', () => ({ default: 'AuthRequired' }))
mock.module('@/components/back-top', () => ({ default: 'BackTop', BACK_TOP_THRESHOLD: 500 }))
mock.module('@/components/empty-state', () => ({ default: 'EmptyState' }))
mock.module('@/components/top-bar', () => ({ default: 'TopBar' }))
mock.module('@/features/auth/demo', () => ({ DEMO_AUTH_ENABLED: false }))
mock.module('@/features/load-failure', () => ({ MOCK_FALLBACK_ENABLED: false }))
mock.module('@/features/auth/guard', () => ({ useAuthGuard: () => 'authed' }))
const account = encodePublicId('usr', '01930000-0000-7000-8000-00000000000a')
mock.module('@/features/auth/store', () => ({ useAuth: () => ({ user: { id: account } }) }))
mock.module('@/features/chat/api', () => ({
  createConversation: () => {},
  describeCreateConversationFailure: () => '',
}))
let request: (path: string, options?: { method?: string }) => Promise<unknown>
mock.module('@/lib/request', () => ({
  apiRequest: (path: string, options?: { method?: string }) => request(path, options),
  isApiError: () => false,
  isUnauthenticatedError: () => false,
}))
const { listSnapshots: cache } = await import('../src/features/list-snapshots')
const { setFavorite } = await import('../src/features/favorites/api')
const { default: Favorites } = await import('../src/pkg-browse/pages/favorites/index')
const response = MyFavoritesResponseSchema.parse({
  items: [1, 2].map((id) => ({
    listing: {
      id: encodePublicId('lst', `01930000-0000-7000-8000-00000000000${id}`),
      title: `Favorite ${id}`,
      priceCents: 1000,
      status: 'ACTIVE',
      category: 'OTHER',
      condition: 'GOOD',
      urgent: false,
      negotiable: false,
      free: false,
      wants: 0,
      views: 0,
      moderationStatus: 'APPROVED',
      coverUrl: null,
      seller: { id: account, nickname: 'Seller', avatarUrl: null, authStatus: 'VERIFIED' },
      createdAt: '2026-09-14T12:00:00.000Z',
    },
    favoritedAt: '2026-09-14T12:00:00.000Z',
  })),
  total: 2,
  nextCursor: null,
})
type Element = { props: Record<string, unknown> }
let tree: unknown
function render() {
  for (let attempt = 0; attempt < 10; attempt++) {
    cursor = 0
    dirty = false
    effects = []
    tree = Favorites()
    if (dirty) continue
    for (const effect of effects) effect()
    if (!dirty) return
  }
  throw new Error('render did not settle')
}
function elements(value: unknown = tree): Element[] {
  if (Array.isArray(value)) return value.flatMap((child) => elements(child))
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const element = value as Element
  return [element, ...Object.values(element.props).flatMap((child) => elements(child))]
}
function byClass(name: string) {
  return required(elements().find((element) => element.props.className === name))
}
function click(element: Element, prop = 'onClick') {
  const handler = element.props[prop]
  if (typeof handler !== 'function') throw new Error(`Missing ${prop}`)
  handler()
  render()
}
async function settle() {
  // Flush the API/schema/cancellable/page promise chain, not wall-clock timing.
  for (let i = 0; i < 20; i++) await Promise.resolve()
  render()
}
function selectAll() {
  click(byClass('fav__manage'))
  click(byClass('fav__all'))
}
beforeEach(() => {
  slots = []
  didHide = () => {}
  toasts.length = 0
  cache.syncAccount(null)
  cache.syncAccount(account)
  request = async () => response
})

test('hiding without unmount retires a batch and return permits a new batch', async () => {
  const writes: Array<() => void> = []
  request = async (_path, options) =>
    options?.method === 'DELETE'
      ? new Promise((resolve) => {
          writes.push(() => resolve({ favorited: false }))
        })
      : response
  render()
  didShow()
  await settle()
  selectAll()
  click(byClass('fav__remove'))
  expect(writes).toHaveLength(1)
  didHide() // navigateTo hides the page, but deliberately never runs effect cleanup.
  required(writes[0])()
  await settle()
  expect(writes).toHaveLength(1)
  expect(toasts).toEqual([])
  didShow()
  await settle()
  click(byClass('fav__all'))
  click(byClass('fav__remove'))
  expect(writes).toHaveLength(2)
  required(writes[1])()
  await settle()
  expect(writes).toHaveLength(3)
  required(writes[2])()
  await settle()
  expect(toasts).toEqual(['已取消 2 件收藏'])
})

test('return during detail favorite write offers visible retry and recovers after settlement', async () => {
  render()
  didShow()
  await settle()
  expect(elements().filter((element) => element.props.className === 'fav__item')).toHaveLength(2)
  didHide()
  let finish = () => {}
  request = async (_path, options) =>
    options?.method === 'DELETE'
      ? new Promise((resolve) => {
          finish = () => resolve({ favorited: false })
        })
      : response
  const mutation = setFavorite(required(response.items[0]).listing.id, false)
  didShow()
  await settle()
  const retry = elements().find((element) => element.props.actionText === '重试')
  expect(retry).toBeDefined()
  expect(cache.read('favorites', account)).toBeNull()
  finish()
  await mutation
  click(required(retry), 'onAction')
  await settle()
  expect(elements().filter((element) => element.props.className === 'fav__item')).toHaveLength(2)
  expect(elements().some((element) => element.props.actionText === '重试')).toBe(false)
  expect(cache.read('favorites', account)?.items).toHaveLength(2)
})

test('first entry effect and didShow issue one request; returning still refreshes', async () => {
  let reads = 0
  request = async () => {
    reads += 1
    return response
  }
  render()
  didShow()
  await settle()
  expect(reads).toBe(1)
  didHide()
  didShow()
  await settle()
  expect(reads).toBe(2)
})
