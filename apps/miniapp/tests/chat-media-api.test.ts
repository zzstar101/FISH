import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { CHAT_ROUTES } from '@fish/contracts/chat/routes'

/**
 * 会话媒体平台层的在途闸（#67 复查 #222）。
 *
 * 复查指出的两类缺口都出在「异步回来晚了一步」，光看组件接线看不出来，所以这里真的把
 * `media-api` 跑起来，只替换它脚下三个平台依赖（Taro / 会话 cookie / `apiRequest`）：
 *
 * 1. **上传链只在外层守卫**：页面手里的 `isStale()` 是在整条链**返回之后**才跑的写状态
 *    守卫，而链里是「读文件 → presign → 直传 PUT」。judge 必须在每一步发请求前现问，
 *    否则换号后 presign / PUT 照发，对象存储里留下没人引用的对象。
 * 2. **迟到的下载会写模块缓存**：`downloadFile` 回来时若已经换号 / 离页，这份字节属于
 *    上一个身份，写进模块级缓存就会被下一个身份复用（私有媒体的临时文件不该跨身份）。
 *
 * 手法与 `unread-count-api.test.ts` / `realtime-client.test.ts` 一致：`mock.module` 之后
 * 再 `await import(...)` 被测模块。驱动时序的钩子（`duringRead` / `duringDownload`）在
 * 「异步已经发出、还没回给调用方」的那一刻把判据翻成 false，正是换号发生的时刻。
 */

type ApiCall = { path: string; method?: string; body?: unknown }
type UploadCall = { url: string; method?: string; header?: Record<string, string> }

const apiCalls: ApiCall[] = []
const uploads: UploadCall[] = []
const downloads: { url: string; header?: Record<string, string> }[] = []

let presignResponse: unknown = null
let uploadStatus = 200
let downloadStatus = 200

/** 「读本地文件已经读完、还没来得及检查身份」时执行的钩子 */
let duringRead: (() => void) | null = null
/** 「下载已经回来、还没来得及写缓存」时执行的钩子 */
let duringDownload: (() => void) | null = null

mock.module('@tarojs/taro', () => ({
  default: {
    getFileSystemManager: () => ({
      readFile: (option: { filePath: string; success: (res: { data: unknown }) => void }) => {
        option.success({ data: new Uint8Array([1, 2, 3, 4]).buffer })
        duringRead?.()
      },
    }),
    request: async (option: UploadCall) => {
      uploads.push({ url: option.url, method: option.method, header: option.header })
      return { statusCode: uploadStatus }
    },
    downloadFile: async (option: { url: string; header?: Record<string, string> }) => {
      downloads.push({ url: option.url, header: option.header })
      duringDownload?.()
      return { statusCode: downloadStatus, tempFilePath: 'wxfile://tmp/media.bin' }
    },
  },
}))

mock.module('@/lib/session', () => ({
  sessionCookieHeader: () => 'fish_session=aaa',
}))

mock.module('@/lib/request', () => ({
  apiRequest: async (path: string, options?: Omit<ApiCall, 'path'>) => {
    apiCalls.push({ path, ...options })
    return presignResponse
  },
}))

const { MediaAbortedError } = await import('../src/features/chat/media')
const { cachedMediaPath, clearMediaCache, downloadChatMedia, uploadChatImage } = await import(
  '../src/features/chat/media-api'
)

const CONVERSATION = '01930000-0000-7000-8000-000000000041'
const MEDIA = '01930000-0000-7000-8000-0000000000a1'

const IMAGE = {
  path: 'wxfile://tmp/pick.png',
  mime: 'image/png' as const,
  width: 600,
  height: 400,
  sizeBytes: 4,
}

beforeEach(() => {
  apiCalls.length = 0
  uploads.length = 0
  downloads.length = 0
  clearMediaCache()
  duringRead = null
  duringDownload = null
  uploadStatus = 200
  downloadStatus = 200
  presignResponse = {
    uploadUrl: 'http://localhost:9000/fish/chat-media/up',
    objectKey: `chat-media/${CONVERSATION}/me/1.png`,
    headers: {},
    expiresAt: '2026-01-01T00:00:00.000Z',
  }
})

describe('downloadChatMedia —— 下载回来时身份已经变了（#67 复查 #222）', () => {
  test('点播放 → 下载挂起 → 换号：抛 MediaAbortedError，且不写模块缓存', async () => {
    let active = true
    duringDownload = () => {
      active = false
    }
    const promise = downloadChatMedia(CONVERSATION, MEDIA, () => active)

    await expect(promise).rejects.toBeInstanceOf(MediaAbortedError)
    // 关键断言：上一个身份的私有媒体临时文件没有进模块级缓存
    // （否则下一个身份 `cachedMediaPath` 会命中它，直接看到别人的图）
    expect(cachedMediaPath(MEDIA)).toBeNull()
  })

  test('离页（判据在下载期间变假）同样不写缓存 —— 与换号同一条路径', async () => {
    let alive = true
    duringDownload = () => {
      alive = false
    }
    await expect(downloadChatMedia(CONVERSATION, MEDIA, () => alive)).rejects.toBeInstanceOf(
      MediaAbortedError,
    )
    expect(cachedMediaPath(MEDIA)).toBeNull()
  })

  test('身份一直有效：正常写缓存并返回临时路径', async () => {
    await expect(downloadChatMedia(CONVERSATION, MEDIA, () => true)).resolves.toBe(
      'wxfile://tmp/media.bin',
    )
    expect(cachedMediaPath(MEDIA)).toBe('wxfile://tmp/media.bin')
  })

  test('不传判据时保持旧行为（调用方不关心归属）', async () => {
    await expect(downloadChatMedia(CONVERSATION, MEDIA)).resolves.toBe('wxfile://tmp/media.bin')
    expect(cachedMediaPath(MEDIA)).toBe('wxfile://tmp/media.bin')
  })

  test('下载地址走鉴权代理（`CHAT_ROUTES.mediaObject`），并带上会话 Cookie', async () => {
    await downloadChatMedia(CONVERSATION, MEDIA, () => true)
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.url).toBe(
      `http://localhost:3000${CHAT_ROUTES.mediaObject(CONVERSATION, MEDIA)}`,
    )
    expect(downloads[0]?.header).toEqual({ Cookie: 'fish_session=aaa' })
  })

  test('缓存命中不再发第二次下载（换号会先 clearMediaCache，所以不会跨身份命中）', async () => {
    await downloadChatMedia(CONVERSATION, MEDIA, () => true)
    await downloadChatMedia(CONVERSATION, MEDIA, () => true)
    expect(downloads).toHaveLength(1)
  })

  test('非 2xx 仍然按失败抛（鉴权闸不能把真失败也吞成「已中止」）', async () => {
    downloadStatus = 404
    await expect(downloadChatMedia(CONVERSATION, MEDIA, () => true)).rejects.toThrow('媒体加载失败')
    expect(cachedMediaPath(MEDIA)).toBeNull()
  })
})

describe('uploadChatImage —— 上传链每一步都问一次在途判据（#67 复查 #222）', () => {
  test('读完文件就换号：presign 与 PUT 都不再发出', async () => {
    let active = true
    duringRead = () => {
      active = false
    }
    await expect(uploadChatImage(CONVERSATION, IMAGE, () => active)).rejects.toBeInstanceOf(
      MediaAbortedError,
    )
    // 这两条是复查的核心：修复前它们都是 1（请求已经以新账号的身份发出去了）
    expect(apiCalls).toHaveLength(0)
    expect(uploads).toHaveLength(0)
  })

  test('presign 回来后才换号：PUT 不再发出（对象存储里不留没人引用的对象）', async () => {
    let active = true
    const original = presignResponse
    presignResponse = new Proxy(original as object, {
      get: (target, key) => {
        const value = Reflect.get(target, key)
        // 契约解析读完 uploadUrl / objectKey 之后才轮到 PUT，这里在解析中途翻判据
        active = false
        return value
      },
    })
    await expect(uploadChatImage(CONVERSATION, IMAGE, () => active)).rejects.toBeInstanceOf(
      MediaAbortedError,
    )
    expect(apiCalls).toHaveLength(1)
    expect(uploads).toHaveLength(0)
  })

  test('身份一直有效：presign → PUT（显式带 content-type）→ 返回声明值', async () => {
    const uploaded = await uploadChatImage(CONVERSATION, IMAGE, () => true)

    expect(apiCalls[0]?.path).toBe(CHAT_ROUTES.mediaPresign(CONVERSATION))
    expect(apiCalls[0]?.body).toEqual({
      kind: 'IMAGE',
      contentType: 'image/png',
      sizeBytes: 4,
    })
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.method).toBe('PUT')
    expect(uploads[0]?.header).toEqual({ 'content-type': 'image/png' })
    // sizeBytes 取读出来的真实字节长度，width/height 取调用方（页面用 getImageInfo）报的
    expect(uploaded).toEqual({
      kind: 'IMAGE',
      objectKey: `chat-media/${CONVERSATION}/me/1.png`,
      contentType: 'image/png',
      sizeBytes: 4,
      width: 600,
      height: 400,
    })
  })

  test('PUT 非 2xx → 可重试的失败文案（不是 MediaAbortedError）', async () => {
    uploadStatus = 500
    await expect(uploadChatImage(CONVERSATION, IMAGE, () => true)).rejects.toThrow(
      '图片发送失败，请重试',
    )
  })
})
