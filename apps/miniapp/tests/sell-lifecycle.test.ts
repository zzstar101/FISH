import { describe, expect, test } from 'bun:test'
import {
  beginTask,
  canLoadEditTarget,
  clearedSellScope,
  isTaskCurrent,
  ownerChanged,
  type SelectedPhoto,
  type SellTask,
  shouldDropPendingTarget,
} from '../src/pages/sell/view'

/**
 * 出物页账号作用域判据的回归（#170 判据 C）。
 *
 * 出物是常驻 Tab 页，页面级 state 与四条异步链（编辑目标 / 图片上传 / 提交 / AI 润色）都
 * 可能跨过一次换号。锁的是只看单帧状态看不出来的时序：
 * - `authed(A) → authed(B)` 的**同一渲染周期**内清干净 A 的表单、图片、编辑目标与润色候选；
 * - A 的在途响应（成功、失败、`finally` 解锁）不得落进 B 的页面；
 * - `A → B → A` 时 A 的**旧**响应不得写进 A 的新会话 —— 只比对 ownerId 挡不住这条；
 * - 冷启动 `authStatus === 'unknown'` 阶段不得发 `GET /listings/:id`（挂 `requireAuth`）。
 *
 * 两层：
 * 1. 判据层 —— 跑 `view.ts` 的纯函数，用最小的「页面 + 写任务」模型模拟交错；
 * 2. 接线层 —— 读 `index.tsx` 源码，断言四条链**确实**接上了这些守卫。
 *
 * 边界：接线层只证明源码里有这些语句，不证明运行时时序（React 批处理、Taro 生命周期回调
 * 的时机、ref 读取时刻）。那部分按 A/B/C 时序在微信开发者工具实测
 * （`docs/miniapp-dev-workflow.md` §5），不拿本文件当端上证明。
 */

/** 一张已选图片（`status: 'done'` 表示上传完成、带 objectKey） */
function photo(id: string, objectKey: string | null): SelectedPhoto {
  return {
    id,
    path: `/tmp/${id}.jpg`,
    url: `/tmp/${id}.jpg`,
    mime: 'image/jpeg',
    sizeBytes: 1024,
    status: 'done',
    objectKey,
    error: null,
  }
}

/** 一个最小的「页面 + 写任务」模型：只保留跨账号交错需要的字段 */
function page() {
  return {
    ownerId: null as string | null,
    epoch: 0,
    mode: null as string | null,
    ...clearedSellScope(),
  }
}

type Page = ReturnType<typeof page>

/** 换账号：渲染期同步清场 + 代次前进（对应 index.tsx 的 `ownerChanged` 分支） */
function switchOwner(p: Page, next: string | null): void {
  if (!ownerChanged(p.ownerId, next)) return
  p.ownerId = next
  p.epoch += 1
  p.mode = null
  Object.assign(p, clearedSellScope())
}

/** 页面卸载：在途任务一并作废（对应 index.tsx 的卸载 effect） */
function unmount(p: Page): void {
  p.epoch += 1
}

/** 响应落地：只有任务仍属于当前账号、且这一轮没被作废才允许写入 */
function settle(p: Page, task: SellTask, write: () => void): boolean {
  if (!isTaskCurrent(task, p.epoch, p.ownerId)) return false
  write()
  return true
}

describe('出物页编辑目标门禁', () => {
  test('冷启动 unknown 阶段不取商品详情', () => {
    expect(canLoadEditTarget(false, null)).toBe(false)
  })

  test('已登录但没有 userId 时仍不取（身份未就绪）', () => {
    expect(canLoadEditTarget(true, null)).toBe(false)
  })

  test('身份就绪后才取', () => {
    expect(canLoadEditTarget(true, 'user-a')).toBe(true)
  })

  test('退出登录后不再取', () => {
    expect(canLoadEditTarget(false, 'user-a')).toBe(false)
  })

  test('冷启动身份解析不算换号：unknown 窗口里记下的编辑目标要留给新身份', () => {
    // 页面在身份未就绪时收到 `?id=`，先记进 pendingEditRef
    let pending: string | null = 'listing-x'
    const prevUserId: string | null = null

    // 身份解析成 user-a：ownerChanged 为真，但不是换号，目标不能被当成残留清掉
    if (shouldDropPendingTarget(prevUserId)) pending = null
    expect(pending).toBe('listing-x')
  })

  test('真正的换号（退出 / 切到别人）要丢掉上一个账号的编辑目标', () => {
    let pending: string | null = 'listing-a'
    const prevUserId: string | null = 'user-a'

    if (shouldDropPendingTarget(prevUserId)) pending = null
    expect(pending).toBeNull()
  })
})

describe('出物页换号清场', () => {
  test('owner 变化的两个方向都算换号，同号广播不算', () => {
    expect(ownerChanged(null, 'user-a')).toBe(true)
    expect(ownerChanged('user-a', 'user-b')).toBe(true)
    expect(ownerChanged('user-a', null)).toBe(true)
    expect(ownerChanged('user-a', 'user-a')).toBe(false)
    expect(ownerChanged(null, null)).toBe(false)
  })

  test('清场清单覆盖全部账号作用域字段（漏一项就会让 B 继承 A 的东西）', () => {
    expect(clearedSellScope()).toEqual({
      editId: null,
      title: '',
      description: '',
      price: '',
      category: null,
      condition: 'LIKE_NEW',
      free: false,
      urgent: false,
      negotiable: true,
      photos: [],
      existingImages: [],
      editState: 'idle',
      polish: { phase: 'idle' },
      cooldown: null,
      fieldErrors: {},
      blockMessage: '',
      submitting: false,
      pendingReviewId: null,
    })
  })

  test('换号后回到新建态：不带 A 的表单、图片、编辑目标、候选、冷却与字段错误', () => {
    const p = page()
    switchOwner(p, 'user-a')
    Object.assign(p, {
      editId: 'listing-a',
      mode: 'listing-a',
      title: 'A 的旧书',
      description: '九成新',
      price: '10',
      category: 'BOOKS' as const,
      condition: 'GOOD' as const,
      free: false,
      urgent: true,
      negotiable: false,
      photos: [photo('p1', 'listings/a/1.jpg')],
      existingImages: ['https://cdn.example.com/a.jpg'],
      editState: 'idle' as const,
      polish: {
        phase: 'ready' as const,
        candidates: [],
        index: 0,
        provider: 'stub' as const,
        redacted: true,
      },
      cooldown: { kind: 'short' as const, secondsLeft: 12 },
      fieldErrors: { title: '描述中有违规内容' },
      blockMessage: '有 1 处要改',
      submitting: true,
      pendingReviewId: 'listing-review',
    })

    switchOwner(p, 'user-b')

    // 起点是「未登录」（epoch 0），A、B 各换一次 → 代次 2
    expect(p).toEqual({
      ownerId: 'user-b',
      epoch: 2,
      mode: null,
      ...clearedSellScope(),
    })
  })
})

describe('出物页 owner/epoch 交错', () => {
  test('A 在途的编辑详情不得填进 B 的表单', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')
    switchOwner(p, 'user-b')
    const taskB = beginTask(p.epoch, 'user-b')

    const wrote = settle(p, taskA, () => {
      p.editId = 'listing-a'
      p.title = 'A 的商品'
      p.existingImages = ['https://cdn.example.com/a.jpg']
    })
    expect(wrote).toBe(false)
    expect(p.title).toBe('')
    expect(p.editId).toBeNull()
    expect(p.existingImages).toEqual([])

    expect(
      settle(p, taskB, () => {
        p.editId = 'listing-b'
        p.title = 'B 的商品'
      }),
    ).toBe(true)
    expect(p.title).toBe('B 的商品')
  })

  test('A 在途上传得到的 objectKey 不得留在 B 的表单里', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, 'user-b')
    // B 自己选了一张，正在上传
    const taskB = beginTask(p.epoch, 'user-b')
    p.photos = [photo('b1', null)]

    settle(p, taskA, () => {
      p.photos = p.photos.map((item) =>
        item.id === 'a1' ? { ...item, objectKey: 'listings/a/1.jpg' } : item,
      )
    })
    expect(p.photos.map((item) => item.objectKey)).toEqual([null])

    settle(p, taskB, () => {
      p.photos = p.photos.map((item) =>
        item.id === 'b1' ? { ...item, objectKey: 'listings/b/1.jpg' } : item,
      )
    })
    expect(p.photos.map((item) => item.objectKey)).toEqual(['listings/b/1.jpg'])
  })

  test('A 在途提交：不把 B 挂上审核中、不把 B 送去 A 的详情、finally 不解 B 的锁', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, 'user-b')
    const taskB = beginTask(p.epoch, 'user-b')
    p.submitting = true
    const navigated: string[] = []

    settle(p, taskA, () => {
      p.pendingReviewId = 'listing-a'
      navigated.push('listing-a')
    })
    expect(p.pendingReviewId).toBeNull()
    expect(navigated).toEqual([])

    // A 的 finally 迟到：不能解开 B 已经点下的那一次
    settle(p, taskA, () => {
      p.submitting = false
    })
    expect(p.submitting).toBe(true)

    expect(
      settle(p, taskB, () => {
        navigated.push('listing-b')
        p.submitting = false
      }),
    ).toBe(true)
    expect(navigated).toEqual(['listing-b'])
    expect(p.submitting).toBe(false)
  })

  test('A 在途的润色候选与 429 冷却不得落到 B 的弹层 / 按钮上', () => {
    const p = page()
    switchOwner(p, 'user-a')
    p.polish = { phase: 'loading' }
    const taskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, 'user-b')
    const taskB = beginTask(p.epoch, 'user-b')
    p.polish = { phase: 'loading' }

    settle(p, taskA, () => {
      p.polish = {
        phase: 'ready',
        candidates: [],
        index: 0,
        provider: 'stub',
        redacted: false,
      }
      p.cooldown = { kind: 'short', secondsLeft: 30 }
    })
    expect(p.polish).toEqual({ phase: 'loading' })
    expect(p.cooldown).toBeNull()

    expect(
      settle(p, taskB, () => {
        p.polish = { phase: 'idle' }
      }),
    ).toBe(true)
    expect(p.polish).toEqual({ phase: 'idle' })
  })

  test('退出登录到 null 也算换 owner，在途任务同样作废', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, null)
    expect(settle(p, taskA, () => undefined)).toBe(false)
  })

  test('A → B → A：A 的旧响应不得写进 A 的新会话（只比 ownerId 会漏这条）', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const staleTaskA = beginTask(p.epoch, 'user-a')

    switchOwner(p, 'user-b')
    switchOwner(p, 'user-a')
    const freshTaskA = beginTask(p.epoch, 'user-a')

    // 账号 id 与当前一致，只有代次能证明它是上一轮的
    expect(staleTaskA.ownerId).toBe('user-a')
    expect(p.ownerId).toBe('user-a')
    expect(settle(p, staleTaskA, () => undefined)).toBe(false)
    expect(settle(p, freshTaskA, () => undefined)).toBe(true)
  })

  test('卸载后迟到响应一律作废', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const taskA = beginTask(p.epoch, 'user-a')

    unmount(p)
    expect(settle(p, taskA, () => undefined)).toBe(false)
  })

  test('同账号内不误伤：没有换号时任务仍然有效', () => {
    const p = page()
    switchOwner(p, 'user-a')
    const task = beginTask(p.epoch, 'user-a')
    expect(settle(p, task, () => undefined)).toBe(true)
  })
})

/** 取 `index.tsx` 里 `from` 到其后第一个 `to` 之间的源码 */
async function pageSlice(from: string, to: string): Promise<string> {
  const code = await Bun.file(new URL('../src/pages/sell/index.tsx', import.meta.url)).text()
  const start = code.indexOf(from)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = code.indexOf(to, start)
  expect(end).toBeGreaterThan(start)
  return code.slice(start, end)
}

describe('出物页接线（#170 判据 C）', () => {
  test('换号清场块覆盖全部 18 个账号作用域 state，并让代次前进、清掉编辑模式与在途润色', async () => {
    const block = await pageSlice(
      'if (ownerChanged(prevUserId, userId)) {',
      'const taskAlive = (task: SellTask)',
    )
    const setters = [
      'setEditId',
      'setTitle',
      'setDescription',
      'setPrice',
      'setCategory',
      'setCondition',
      'setFree',
      'setUrgent',
      'setNegotiable',
      'setPhotos',
      'setExistingImages',
      'setEditState',
      'setPolish',
      'setCooldown',
      'setFieldErrors',
      'setBlockMessage',
      'setSubmitting',
      'setPendingReviewId',
    ]
    for (const setter of setters) expect(block).toContain(`${setter}(cleared.`)
    expect(block).toContain('epochRef.current += 1')
    expect(block).toContain('modeRef.current = null')
    expect(block).toContain('polishCancelRef.current?.()')
    // 编辑目标只按「上一个账号」判断是否丢弃：无条件清掉会把冷启动那个目标也吞了
    expect(block).toContain(
      'if (shouldDropPendingTarget(prevUserId)) pendingEditRef.current = null',
    )
    expect(block).not.toMatch(/^\s*pendingEditRef\.current = null$/m)
  })

  test('卸载时作废在途任务并放开飞行中的润色请求', async () => {
    const code = await Bun.file(new URL('../src/pages/sell/index.tsx', import.meta.url)).text()
    expect(code).toMatch(
      /epochRef\.current \+= 1\s*\n\s*polishCancelRef\.current\?\.\(\)\s*\n\s*polishCancelRef\.current = null/,
    )
  })

  test('任务存活判据同时比对代次与账号', async () => {
    const code = await Bun.file(new URL('../src/pages/sell/index.tsx', import.meta.url)).text()
    expect(code).toContain('isTaskCurrent(task, epochRef.current, ownerRef.current)')
  })

  test('编辑目标：unknown 阶段不发请求、先记目标，身份就绪后补一次交接', async () => {
    const sync = await pageSlice('const syncEditTarget = () => {', 'useDidShow(syncEditTarget)')
    expect(sync).toContain("canLoadEditTarget(authStatus === 'authed', ownerRef.current)")
    expect(sync).toContain('pendingEditRef.current = target')

    const handoff = await pageSlice('身份就绪后补一次编辑目标交接', 'const goDetail')
    expect(handoff).toContain('pendingEditRef.current')
    expect(handoff).toContain('loadForEditRef.current(target)')
  })

  test('编辑详情：成功与失败落地前都确认任务仍属于当前账号', async () => {
    const block = await pageSlice('const loadForEdit = (id: string) => {', 'const loadForEditRef')
    expect(block.match(/if \(!taskAlive\(task\)\) return/g) ?? []).toHaveLength(2)
  })

  test('图片上传：成功与失败回写前都确认任务仍属于当前账号', async () => {
    const block = await pageSlice(
      'const startUpload = (photo: SelectedPhoto, task: SellTask) => {',
      'const pickImage',
    )
    expect(block.match(/if \(!taskAlive\(task\)\) return/g) ?? []).toHaveLength(2)
  })

  test('提交：结果与错误都受守卫，finally 不再无条件解锁', async () => {
    const block = await pageSlice('const submit = () => {', '* 冷却倒计时。')
    expect(block.match(/if \(!taskAlive\(task\)\) return/g) ?? []).toHaveLength(2)
    expect(block).toContain('if (taskAlive(task)) setSubmitting(false)')
    expect(block).not.toMatch(/finally \{\s*setSubmitting\(false\)/)
  })

  test('AI 润色：成功与失败落地前都确认任务仍属于当前账号', async () => {
    const block = await pageSlice(
      'const requestPolish = (selectedCategory: ListingCategory)',
      '/** 关 sheet',
    )
    expect(block.match(/!taskAlive\(task\)/g) ?? []).toHaveLength(2)
    expect(block).toContain('load.isCancelled() || !taskAlive(task)')
  })

  test('选图：任务在选图之前铸好，结果落地前确认任务仍属于当前账号', async () => {
    const block = await pageSlice('const pickImage = () => {', 'const retryUpload')
    expect(block.indexOf('const task = beginTask(')).toBeLessThan(
      block.indexOf('await pickPhotos('),
    )
    expect(block.match(/if \(!taskAlive\(task\)\) return/g) ?? []).toHaveLength(2)
  })

  test('每条链都在第一次 await 之前铸任务（在 await 之后铸等于用新账号给旧请求签发通行证）', async () => {
    const chains = [
      ['编辑详情', 'const loadForEdit = (id: string) => {', 'const loadForEditRef'],
      ['重传', 'const retryUpload = (photo: SelectedPhoto) => {', 'const handleSubmitError'],
      ['提交', 'const submit = () => {', '* 冷却倒计时。'],
      ['AI 润色', 'const requestPolish = (selectedCategory: ListingCategory)', '/** 关 sheet'],
    ] as const
    for (const [name, from, to] of chains) {
      const block = await pageSlice(from, to)
      const created = block.indexOf('const task = beginTask(')
      expect(created, `${name}：没有在链内铸任务`).toBeGreaterThanOrEqual(0)
      const firstAwait = block.indexOf('await ')
      expect(firstAwait === -1 || created < firstAwait, `${name}：任务铸在第一次 await 之后`).toBe(
        true,
      )
    }
  })
})
