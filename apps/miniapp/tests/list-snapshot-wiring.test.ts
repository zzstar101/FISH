import { expect, test } from 'bun:test'

async function code(path: string) {
  return (await Bun.file(new URL(`../src/${path}`, import.meta.url)).text())
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

test('orders hydrate raw snapshots and guard late responses before display/write', async () => {
  const source = await code('features/transaction/useOrderList.ts')
  expect(source).toContain('listSnapshots.read(')
  expect(source).toContain('listSnapshots.begin(')
  expect(source).toContain('listSnapshots.isCurrent(')
  expect(source).toContain('listSnapshots.write(')
})

test('favorites refresh failure retains rows and count; retry does not hide existing rows', async () => {
  const source = await code('pkg-browse/pages/favorites/index.tsx')
  const failure = source.slice(source.indexOf('} catch (caught) {'), source.indexOf('// `null`'))
  expect(failure).not.toContain('setItems([])')
  expect(failure).not.toContain('setTotal(0)')
  expect(source).toContain('useDidShow(')
  expect(source).toContain('error !== null && items.length === 0')
})

test('authoritative auth emission synchronizes snapshot owner before notifying views', async () => {
  const source = await code('features/auth/store.ts')
  const sync = source.indexOf('listSnapshots.syncAccount(')
  expect(sync).toBeGreaterThan(-1)
  expect(sync).toBeLessThan(source.indexOf('for (const listener of listeners)'))
})

test('successful relevant domain writes invalidate snapshots at API boundary', async () => {
  for (const [path, names] of [
    [
      'features/transaction/api.ts',
      ['confirmTransaction', 'acceptTransaction', 'cancelTransaction'],
    ],
    [
      'features/listing/api.ts',
      ['updateListing', 'offlineListing', 'onlineListing', 'deleteListing'],
    ],
    ['features/favorites/api.ts', ['setFavorite']],
  ] as const) {
    const source = await code(path)
    for (const name of names) {
      const body = source.split(`export async function ${name}(`)[1]?.split('\nexport ')[0]
      expect(body, name).toContain('listSnapshots.startMutation(')
    }
  }
})

test('batch removal keeps unselected rows and guards account changes between writes', async () => {
  const source = await code('pkg-browse/pages/favorites/index.tsx')
  const body = source
    .split('const removePicked = async () => {')[1]
    ?.split('const onEmptyAction')[0]
  expect(body).toContain('!removedIds.has(item.id)')
  expect(body).toContain('listSnapshots.isOwner(')
})
