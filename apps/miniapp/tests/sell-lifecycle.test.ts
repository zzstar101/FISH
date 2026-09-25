import { describe, expect, test } from 'bun:test'
import { assertUploadActive, UploadAbortedError } from '../src/features/upload/active'
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

/** 取任意源文件里 `from` 到其后第一个 `to` 之间的源码（接线层用） */
async function fileSlice(file: string, from: string, to: string): Promise<string> {
  const code = await Bun.file(new URL(file, import.meta.url)).text()
  const start = code.indexOf(from)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = code.indexOf(to, start)
  expect(end).toBeGreaterThan(start)
  return code.slice(start, end)
}

/** 断言 `first` 出现在 `second` 之前（两者都必须存在） */
function expectBefore(block: string, first: string, second: string): void {
  const i = block.indexOf(first)
  const j = block.indexOf(second)
  expect(i, `应出现 ${first}`).toBeGreaterThanOrEqual(0)
  expect(j, `应出现 ${second}`).toBeGreaterThanOrEqual(0)
  expect(i, `${first} 应在 ${second} 之前`).toBeLessThan(j)
}

/**
 * 多步上传链的逐步在途检查（#170 复查 #208）。
 *
 * 复查原话：`startUpload()` 在整个 `uploadListingImage()` 返回之后才检查任务，而后者内部
 * 还有 presign → 读文件 → PUT → confirm 多步；换号 / 卸载后旧链**是否继续发鉴权请求**要单独
 * 验证，必要时把检查贯穿每一步。结论是「会继续发」，所以这里锁两件事：
 * - 判据层：中止信号是独立的错误类型，链上每一步发请求前都问一遍归属；
 * - 接线层：三步各有一道检查、且**紧挨着自己的那一步**（挪到请求之后就算失效），出物页
 *   把 `() => taskAlive(task)` 交给适配器，中止时 catch 的第一个语句就是不写状态。
 */
describe('多步上传链的逐步在途检查（#170 复查 #208）', () => {
  test('不传判据时保持旧行为（一次性调用不关心归属）', () => {
    expect(() => assertUploadActive()).not.toThrow()
    expect(() => assertUploadActive(() => true)).not.toThrow()
  })

  test('判据为假：抛的是中止信号，不是普通上传失败文案', () => {
    let thrown: unknown = null
    try {
      assertUploadActive(() => false)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UploadAbortedError)
    expect(thrown).toBeInstanceOf(Error)
  })

  test('起飞后换号：剩下每一步的请求都不再发出，只留下已经发出的那一步', () => {
    let active = true
    const sent: string[] = []
    const step = (name: string) => {
      assertUploadActive(() => active)
      sent.push(name)
    }
    step('presign')
    // 换号 / 卸载：epoch 前进，页面上的 `taskAlive(task)` 从这一刻起为假
    active = false
    expect(() => step('put')).toThrow(UploadAbortedError)
    expect(() => step('confirm')).toThrow(UploadAbortedError)
    expect(sent).toEqual(['presign'])
  })

  test('适配器：三步各自在发请求之前问一遍归属（共 3 次，且不跨步复用）', async () => {
    const block = await fileSlice(
      '../src/features/upload/api.ts',
      'export async function uploadListingImage',
      '\n}',
    )
    expect(block).toContain('isActive?: () => boolean')
    const gates = [...block.matchAll(/assertUploadActive\(isActive\)/g)].map(
      (match) => match.index ?? -1,
    )
    const requests = [
      'await apiRequest(UPLOAD_ROUTES.presign',
      'await Taro.request(',
      'await apiRequest(UPLOAD_ROUTES.confirm',
    ].map((marker) => block.indexOf(marker))
    expect(gates).toHaveLength(3)
    for (const [index, at] of requests.entries()) {
      expect(at, `缺少第 ${index + 1} 个请求`).toBeGreaterThan(0)
      const gate = gates.filter((position) => position < at).pop()
      expect(gate, `第 ${index + 1} 个请求之前没有在途检查`).toBeDefined()
      // 检查必须紧挨着自己的那一步：中间不能再夹着别的请求（挪到请求之后即失效）
      const between = requests.filter((other) => (gate ?? 0) < other && other < at)
      expect(between, `第 ${index + 1} 个请求与它的检查之间夹着别的请求`).toEqual([])
    }
  })

  test('出物页把 taskAlive 作为判据交给适配器；中止时 catch 先确认任务、再决定写状态', async () => {
    const block = await pageSlice(
      'const startUpload = (photo: SelectedPhoto, task: SellTask) => {',
      'const pickImage',
    )
    expectBefore(block, 'await uploadListingImage(', '() => taskAlive(task),')
    const catchAt = block.indexOf('} catch (error) {')
    const guardAt = block.indexOf('if (!taskAlive(task)) return', catchAt)
    const setAt = block.indexOf('setPhotos(', catchAt)
    expect(catchAt).toBeGreaterThanOrEqual(0)
    expect(guardAt).toBeGreaterThan(catchAt)
    // 中止 = 任务已失效 ⇒ 直接返回：不写状态，也不给用户弹一条莫名其妙的失败
    expect(setAt).toBeGreaterThan(guardAt)
  })
})

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

describe('预填交接（再次上架 / 重新上架）的接线', () => {
  /*
   * 这两件事之前只靠注释保护，而它们恰恰是下一次解冲突最容易悄悄改掉的：
   * ① prefill 掉到 `routeId` 之后解出 target —— 用户点「再次上架」会掉进另一件商品的编辑态，
   *    那份草稿被静默丢掉；② `applyDraft` 顺手碰图片 —— 但 `POST /listings` 只收
   *    `objectKeys`，而详情刻意不给 `objectKey`，带了也提交不了。
   */
  test('prefill 分支在解出 routeId 目标之前就返回', async () => {
    const sync = await pageSlice('const syncEditTarget = () => {', 'const goDetail')
    expect(sync).toContain("if (handoff?.kind === 'prefill') {")
    expect(sync.indexOf("handoff?.kind === 'prefill'")).toBeLessThan(sync.indexOf(': routeId'))
    // 分支体内就该 return，走不到下面按 routeId 解 target 的那几行
    const branch = await pageSlice("if (handoff?.kind === 'prefill') {", 'const target = handoff')
    expect(branch).toContain('return')
    expect(branch).not.toContain(': routeId')
  })

  test('prefill 分支清掉编辑态、走新建表单', async () => {
    const branch = await pageSlice("if (handoff?.kind === 'prefill') {", 'const target = handoff')
    expect(branch).toContain('modeRef.current = null')
    expect(branch).toContain('setEditId(null)')
    expect(branch).toContain("setEditState('idle')")
    expect(branch).toContain('resetForm()')
    // 提交走新建（`editing = editId !== null`），预填草稿不会变成 PATCH
    expect(branch).toContain('applyDraft(handoff.draft)')
  })

  test('applyDraft 只灌文字字段：一次 setPhotos 都不能有', async () => {
    const apply = await pageSlice('const applyDraft = (draft: SellDraft) => {', 'const resetForm')
    expect(apply).not.toContain('setPhotos')
    expect(apply).not.toContain('setSelectedPhotos')
    expect(apply).toContain('setTitle(draft.title)')
    expect(apply).toContain('setDescription(draft.description)')
  })
})
