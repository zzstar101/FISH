import { describe, expect, test } from 'bun:test'
import {
  appendDisputePage,
  canApplyLoadMore,
  type DisputeLoadMoreRequest,
} from '@/features/disputes/paging'

/**
 * 「我的争议」触底加载的竞态（#497 审查）。
 *
 * 线上形态：手指往下拉 → 第二页请求在途 → 用户下拉刷新（或从详情页返回触发重读，重读会
 * 递增加载代次）→ 旧请求这才回来。旧实现会无条件解锁并追加，于是列表里出现重复行、
 * 锁也会被提前放掉。这里用一个可手动 resolve 的 promise 复刻页面里的持锁/落地判据。
 */

type Row = { id: string; page: number }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 复刻页面 `read()` 与 `loadMore()` 的锁/代次行为（判据本身来自 paging.ts） */
function makeLoader() {
  let epoch = 0
  let lock: DisputeLoadMoreRequest | null = null
  let items: Row[] = []
  return {
    get items(): Row[] {
      return items
    },
    /** 页面 `read()`：递增代次并让在途的触底请求作废 */
    refresh(next: Row[]) {
      epoch += 1
      lock = null
      items = next
    },
    async loadMore(page: () => Promise<Row[]>) {
      if (lock !== null) return
      const request: DisputeLoadMoreRequest = { epoch, token: Symbol('dispute-load-more') }
      lock = request
      const incoming = await page()
      // 过期响应：整段丢弃，且不去清别人的锁
      if (!canApplyLoadMore(request, { epoch, lock })) return
      lock = null
      items = appendDisputePage(items, incoming)
    },
  }
}

describe('我的争议：触底加载竞态', () => {
  test('旧请求在刷新后才返回：丢弃，不把上一份快照的行拼进新列表', async () => {
    const loader = makeLoader()
    loader.refresh([
      { id: 'a', page: 1 },
      { id: 'b', page: 1 },
    ])

    const oldPage = deferred<Row[]>()
    const oldRequest = loader.loadMore(() => oldPage.promise)

    // 用户下拉刷新：第一页内容变了，分页边界也随之变化
    loader.refresh([{ id: 'a', page: 1 }])
    const newPage = deferred<Row[]>()
    const newRequest = loader.loadMore(() => newPage.promise)

    oldPage.resolve([{ id: 'c', page: 2 }])
    await oldRequest
    expect(loader.items).toEqual([{ id: 'a', page: 1 }])

    newPage.resolve([{ id: 'b', page: 2 }])
    await newRequest
    expect(loader.items).toEqual([
      { id: 'a', page: 1 },
      { id: 'b', page: 2 },
    ])
  })

  test('分页边界滑动导致新旧页重叠：按键去重，不出重复卡片', async () => {
    const loader = makeLoader()
    loader.refresh([{ id: 'a', page: 1 }])
    await loader.loadMore(async () => [
      { id: 'a', page: 2 },
      { id: 'b', page: 2 },
    ])
    expect(loader.items.map((row) => row.id)).toEqual(['a', 'b'])
  })

  test('过期响应不释放新一轮的锁：刷新后的第一次触底不会被并发请求打断', async () => {
    const loader = makeLoader()
    loader.refresh([{ id: 'a', page: 1 }])

    const oldPage = deferred<Row[]>()
    const oldRequest = loader.loadMore(() => oldPage.promise)
    loader.refresh([{ id: 'a', page: 1 }])

    const newPage = deferred<Row[]>()
    let newCalls = 0
    const newRequest = loader.loadMore(() => {
      newCalls += 1
      return newPage.promise
    })

    // 旧请求先回来：它不能把新一轮的锁清掉
    oldPage.resolve([])
    await oldRequest
    // 此时再触底：锁仍由新一轮持有，必须被挡住（否则会出现两个并发请求）
    await loader.loadMore(async () => [{ id: 'z', page: 3 }])
    expect(newCalls).toBe(1)

    newPage.resolve([{ id: 'b', page: 2 }])
    await newRequest
    expect(loader.items.map((row) => row.id)).toEqual(['a', 'b'])
  })
})
