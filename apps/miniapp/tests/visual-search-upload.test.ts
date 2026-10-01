import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { MAX_VISUAL_QUERY_IMAGE_BYTES } from '@fish/contracts/visual/schema'
import { UploadAbortedError } from '@/features/upload/active'

/**
 * 查询图上传腿（presign → 直传 PUT）。分支 1 的页面只依赖这一条链，它有三个不能错的地方：
 *
 * 1. **会话头**：presign 必须带匿名会话标识（服务端按主体派生对象键），并且要采纳服务端在
 *    响应头里回写的那个 —— 不采纳的话，这次拿到的 `objectKey` 归到另一个主体上，搜索必然 400。
 * 2. **直传**：PUT 要对准 `presign.url`、带上真实字节与 `content-type`（对象存储按它落对象 mime，
 *    而搜索时服务端要按魔术字节复核，声明成白名单外的值就是给自己埋 400）。
 * 3. **失败口径**：本地预检 / 直传被拒 / 429 都要有自己的话（`visualSearchErrorMessage`）。
 *
 * 为什么用 `mock.module`：`./api` 经 `@/lib/request` 必须 `import Taro`，Bun 下加载真 Taro 会抛
 * `ENABLE_INNER_HTML is not defined`（手法同 `tests/recommendation-module-init.test.ts`）。
 */
const SESSION_KEY = 'fish.visualSearch.sessionId'

type RequestCall = {
  url: string
  method?: string
  header: Record<string, string>
  data?: unknown
}

type MockResponse = { statusCode: number; data: unknown; header: Record<string, string> }

const store = new Map<string, unknown>()
const calls: RequestCall[] = []
/** presign 端点的响应（PUT 直传走 `putResponse`），用例里各自改 */
let presignResponse: MockResponse = { statusCode: 200, data: {}, header: {} }
let putResponse: MockResponse = { statusCode: 200, data: '', header: {} }

/** 取第 n 个请求；没发出来就直接失败（断言里不必再写 `?.`，也挡得住"少发了一发"） */
function callAt(index: number): RequestCall {
  const call = calls[index]
  if (call === undefined) throw new Error(`第 ${index} 个请求没有发出来`)
  return call
}

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => store.get(key) ?? '',
    setStorageSync: (key: string, data: unknown) => {
      store.set(key, data)
    },
    removeStorageSync: (key: string) => {
      store.delete(key)
    },
    getFileSystemManager: () => ({
      readFile: (options: { success: (res: { data: ArrayBuffer }) => void }) => {
        // 4 字节占位：只验「读到的二进制被原样 PUT」，不验图片内容
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
        options.success({ data: bytes.buffer as ArrayBuffer })
      },
    }),
    request: (options: RequestCall): Promise<MockResponse> => {
      calls.push(options)
      if (options.method === 'PUT') return Promise.resolve(putResponse)
      return Promise.resolve(presignResponse)
    },
  },
}))

const { uploadVisualQueryImage, visualSearchErrorMessage } = await import(
  '@/features/visual-search/api'
)

const OBJECT_KEY = 'visual-search/9d1fa0/4b7c.png'
const UPLOAD_URL = `http://localhost:9000/fish/${OBJECT_KEY}`
const PHOTO = { path: '/tmp/query.png', mime: 'image/png', sizeBytes: 4 } as const
const ISSUED = '33333333-3333-4333-8333-333333333333'

function okPresign(header: Record<string, string> = {}): MockResponse {
  return {
    statusCode: 200,
    data: { objectKey: OBJECT_KEY, url: UPLOAD_URL, expiresAt: '2026-01-01T00:00:00.000Z' },
    header,
  }
}

function storedId(): unknown {
  return (store.get(SESSION_KEY) as { id?: unknown } | undefined)?.id
}

describe('uploadVisualQueryImage', () => {
  beforeEach(() => {
    store.clear()
    calls.length = 0
    presignResponse = okPresign()
    putResponse = { statusCode: 200, data: '', header: {} }
  })

  test('presign 带匿名会话头与本地的 mime / 大小', async () => {
    expect(await uploadVisualQueryImage(PHOTO)).toBe(OBJECT_KEY)

    const presign = callAt(0)
    expect(presign.url).toContain('/visual-search/uploads')
    expect(presign.method).toBe('POST')
    expect(presign.data).toEqual({ contentType: 'image/png', sizeBytes: 4 })
    // 会话头就是本地那份（presign 与随后的搜索必须落在同一主体）
    expect(typeof presign.header['x-anonymous-session-id']).toBe('string')
    expect(presign.header['x-anonymous-session-id']).toBe(storedId())
  })

  test('直传 PUT 对准 presign 的 url，带字节与 content-type', async () => {
    await uploadVisualQueryImage(PHOTO)

    const put = callAt(1)
    expect(put.url).toBe(UPLOAD_URL)
    expect(put.method).toBe('PUT')
    expect(put.header).toEqual({ 'content-type': 'image/png' })
    const body = put.data
    expect(body).toBeInstanceOf(ArrayBuffer)
    // 读到的二进制被原样 PUT（4 字节占位）
    expect(body instanceof ArrayBuffer ? body.byteLength : -1).toBe(4)
  })

  test('采纳服务端回写的会话 id（否则这次的对象键属于另一个主体）', async () => {
    presignResponse = okPresign({ 'x-anonymous-session-id': ISSUED })
    await uploadVisualQueryImage(PHOTO)
    expect(storedId()).toBe(ISSUED)
  })

  test('直传被拒：给可重试的文案', async () => {
    putResponse = { statusCode: 403, data: '', header: {} }
    const error = await uploadVisualQueryImage(PHOTO).catch((thrown: unknown) => thrown)
    expect(visualSearchErrorMessage(error)).toBe('图片上传失败,请重试')
  })

  test('429 的错误信封：带上剩余秒数', async () => {
    presignResponse = {
      statusCode: 429,
      data: {
        error: {
          code: 'VISUAL_SEARCH_RATE_LIMITED',
          message: '请求过于频繁',
          retryAfterSeconds: 45,
        },
      },
      header: {},
    }
    const error = await uploadVisualQueryImage(PHOTO).catch((thrown: unknown) => thrown)
    expect(visualSearchErrorMessage(error)).toBe('识图请求太频繁，请 45 秒后再试')
  })

  test('超过查询图上限：本地就挡下，一个请求都不发', async () => {
    const error = await uploadVisualQueryImage({
      ...PHOTO,
      sizeBytes: MAX_VISUAL_QUERY_IMAGE_BYTES + 1,
    }).catch((thrown: unknown) => thrown)
    expect(visualSearchErrorMessage(error)).toBe('图片不能超过 5MB')
    expect(calls).toHaveLength(0)
  })

  test('在途判据失效（换号 / 卸载）：中止且不发请求', async () => {
    const error = await uploadVisualQueryImage(PHOTO, () => false).catch(
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(UploadAbortedError)
    expect(calls).toHaveLength(0)
  })
})
