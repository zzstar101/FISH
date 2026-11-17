import { describe, expect, test } from 'bun:test'

/**
 * 首页首屏分批挂载的**接线**（#595）。
 *
 * 窗口计算本身在 `home-mount-batch.test.ts` 里测（纯函数）。这里钉的是页面有没有
 * 真的把它用上 —— 这几条坏掉时编译器和端上都不报错，只是又变回「一次挂 50 张」：
 * 渲染吃全量 `items`、没人调 `useReachBottom`、或者观察器还在盯全量列表。
 */

async function homeSource(): Promise<string> {
  return await Bun.file(new URL('../src/pages/home/index.tsx', import.meta.url)).text()
}

/** 去掉注释后的源码：断言必须看**代码** */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function flat(source: string): string {
  return source.replace(/\s+/g, ' ')
}

describe('首屏分批挂载：渲染与曝光都只吃已挂载的那一段', () => {
  test('渲染分列吃的是已挂载前缀，不是全量 items', async () => {
    const source = flat(code(await homeSource()))
    expect(source).toContain('splitColumns(mountedItems)')
    // 回归锁：改回全量就等于又一次性挂 50 张
    expect(source).not.toContain('splitColumns(items)')
  })

  test('曝光观察器也只盯已挂载前缀（observeAll 只认 observe 时刻已存在的节点）', async () => {
    const source = flat(code(await homeSource()))
    expect(source).toContain('useFeedImpressions({ items: mountedItems')
    expect(source).not.toContain('useFeedImpressions({ items,')
  })

  test('已挂载前缀由 mountPrefix 按可见名额算出来（隐藏卡不吃名额）', async () => {
    const source = flat(code(await homeSource()))
    expect(source).toContain('mountPrefix(items, hiddenIds, mountedCount)')
  })

  test('滚动触底按批增量，且用 nextMountCount 封顶（全挂完后 setState bail）', async () => {
    const source = flat(code(await homeSource()))
    expect(source).toContain('useReachBottom(')
    expect(source).toContain('nextMountCount(count, visibleCount)')
  })
})

describe('下拉刷新：在顶部触发，收回首屏批量', () => {
  test('usePullDownRefresh 里先归零批量，再拉数据', async () => {
    const source = flat(code(await homeSource()))
    const body = source.slice(
      source.indexOf('usePullDownRefresh(() => {'),
      source.indexOf('const [left, right]'),
    )
    expect(body).toContain('setMountedCount(INITIAL_MOUNT_COUNT)')
    const reset = body.indexOf('setMountedCount(INITIAL_MOUNT_COUNT)')
    const fetch = body.indexOf('void load(category)')
    expect(reset).toBeGreaterThanOrEqual(0)
    expect(fetch).toBeGreaterThanOrEqual(0)
    // 归零要在拉数据之前：落在 then 里就赶不上这次上屏
    expect(reset).toBeLessThan(fetch)
  })
})

describe('回到本页时名单没变就不动 state（否则每次都重建曝光观察器）', () => {
  test('useDidShow 里先比对，未变直接 return', async () => {
    const source = flat(code(await homeSource()))
    const body = source.slice(
      source.indexOf('useDidShow(() => {'),
      source.indexOf('usePullDownRefresh(() => {'),
    )
    expect(body).toContain('const unchanged =')
    expect(body).toContain('if (unchanged) return')
    const guard = body.indexOf('if (unchanged) return')
    const write = body.indexOf('setHiddenIds(next)')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(write).toBeGreaterThan(guard)
  })
})

describe('换一屏回初始批量，原地换数据保留已挂出的部分', () => {
  test('切分类 / 首次进页 / 失败清屏后回初始批量', async () => {
    const source = flat(code(await homeSource()))
    // sameScreen 判据必须在 lastGoodRef 被覆盖之前读
    const sameScreen = source.indexOf(
      'const sameScreen = lastGoodRef.current.loadedFor === next && lastGoodRef.current.items.length > 0',
    )
    expect(
      sameScreen,
      '缺少 sameScreen 判据（否则同分类刷新会把用户拽回第一屏）',
    ).toBeGreaterThanOrEqual(0)
    const reset = source.indexOf(
      'if (!sameScreen && !keepMountCount) setMountedCount(INITIAL_MOUNT_COUNT)',
    )
    expect(
      reset,
      'sameScreen 之外还要认「身份重置时人滚在深处」这个信号（否则刚保留的批量会被这次 load 收回）',
    ).toBeGreaterThanOrEqual(0)
    expect(sameScreen).toBeLessThan(reset)
    // 信号必须在 load 入口读一次即清：后面两道闸都可能提前返回，放落屏处会漏给下一次加载
    const load = source.slice(
      source.indexOf('const load = async'),
      source.indexOf('const sameScreen ='),
    )
    expect(load).toContain('const keepMountCount = keepMountCountRef.current')
    expect(load).toContain('keepMountCountRef.current = false')
  })

  test('快照上屏是全新一屏：回初始批量（重置必须在函数体内，且受保留信号守卫）', async () => {
    const source = flat(code(await homeSource()))
    const paints = source.split('const paintSnapshot =')
    expect(paints).toHaveLength(2)
    /*
      只查「声明之后出现过一次重置」是**恒真**的：`paintSnapshot` 之后还有 `load()` 与
      `resetForIdentityChange` 两处同样的语句，把它们留着、删掉这里这行，断言照样通过。
      所以要比对位置：重置必须落在 `paintSnapshot` 的返回之前。
    */
    const body = paints[1]
    const reset = body.indexOf('if (!keepMountCount) setMountedCount(INITIAL_MOUNT_COUNT)')
    const end = body.indexOf('return true')
    expect(
      reset,
      '快照上屏必须回初始批量（身份重置深滚时除外，所以要受 keepMountCount 形参守卫）',
    ).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThanOrEqual(0)
    expect(reset).toBeLessThan(end)
    /*
      守卫的信号只能由 `load` 传进来：`keepMountCountRef` 在 `load` 入口已读一次即清，
      快照里再读它恒为 false，那条「深滚保留批量」的承诺在 `ALL` + 有快照时就不成立。
    */
    expect(source).toContain(
      "const paintSnapshot = (scope: ListingCategory | 'ALL', keepMountCount: boolean)",
    )
    expect(source).toContain('paintSnapshot(next, keepMountCount)')
  })

  test('身份重置是全新一屏：在顶部就回初始批量（深处则保留，免得位置塌缩）', async () => {
    const source = flat(code(await homeSource()))
    const reset = source.split('const resetForIdentityChange =')
    expect(reset).toHaveLength(2)
    const body = reset[1]
    const call = body.indexOf('setMountedCount(INITIAL_MOUNT_COUNT)')
    expect(call, '身份重置后必须重新决定批量，否则旧身份的批量会带到新身份').toBeGreaterThanOrEqual(
      0,
    )
    // 深滚动时保留批量：判据必须真的守着这次重置，不能无条件执行
    expect(body).toContain('if (scrollTopRef.current <= 0)')
    expect(body.indexOf('if (scrollTopRef.current <= 0)')).toBeLessThan(call)
  })

  test('空态 / 错误态判定仍读全量口径（不是已挂载的那一段）', async () => {
    const source = flat(code(await homeSource()))
    expect(source).toContain('itemCount: visibleCount')
    expect(source).toContain('items.filter((item) => !hiddenIds.includes(item.id)).length')
  })
})
