import { expect, test } from 'bun:test'

// ProfilePage has no Outlet: the verification page must be a sibling, not its child.
test('profile verification is not nested under the profile page', async () => {
  const source = await Bun.file(new URL('./routeTree.gen.ts', import.meta.url)).text()
  const block = source.match(/const ProfileVerificationRoute = [\s\S]*?\} as any\)/)?.[0]
  expect(block).toContain('getParentRoute: () => rootRouteImport')
  expect(source).not.toContain('getParentRoute: () => ProfileRoute')
})
