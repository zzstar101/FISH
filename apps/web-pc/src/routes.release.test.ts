import { describe, expect, test } from 'bun:test'
import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

function routerAt(entry: string) {
  return createRouter({
    routeTree,
    basepath: '/pc',
    notFoundMode: 'root',
    history: createMemoryHistory({ initialEntries: [entry] }),
  })
}

function matchedRouteIds(entry: string): string[] {
  const router = routerAt(entry)
  const location = router.parseLocation(router.history.location)
  return router.matchRoutes(location).map((match) => match.routeId)
}

describe('PC release route boundaries', () => {
  test('deep links resolve inside the PC route tree', () => {
    expect(matchedRouteIds('/pc/search?q=keyboard').at(-1)).toBe('/search')
    expect(matchedRouteIds('/pc/listing/01930000-0000-7000-8000-000000000001').at(-1)).toBe(
      '/listing/$listingId',
    )
    expect(matchedRouteIds('/pc/messages/01930000-0000-7000-8000-000000000002').at(-1)).toBe(
      '/messages/$conversationId',
    )
    expect(matchedRouteIds('/pc/orders/01930000-0000-7000-8000-000000000003').at(-1)).toBe(
      '/orders/$transactionId',
    )
  })

  test('unknown /pc paths resolve to the root not-found boundary', () => {
    const router = routerAt('/pc/no-such-route')
    const location = router.parseLocation(router.history.location)
    const matches = router.matchRoutes(location)

    expect(matches).toHaveLength(1)
    expect(matches[0]?.routeId).toBe('__root__')
    expect(matches[0]?._notFound).toBe(true)
  })

  test('root route keeps provider, error and not-found boundaries wired', () => {
    const router = routerAt('/pc/')
    const root = router.routesById.__root__

    expect(router.options.notFoundMode).toBe('root')
    expect('shellComponent' in root.options).toBe(true)
    expect(root.options.errorComponent).toBeDefined()
    expect(root.options.notFoundComponent).toBeDefined()
  })
})
