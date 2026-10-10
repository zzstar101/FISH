import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { TRANSACTION_REVIEW_ROUTES } from '@fish/contracts/transaction-reviews/routes'

/**
 * 评价配图上传链（#475）的在途闸与三步编排：真的把 `review-media` 跑起来，
 * 只替换它脚下的平台依赖（Taro / `apiRequest`）—— 手法与 `chat-media-api.test.ts`
 * 一致（`mock.module` 之后再 `await import` 被测模块）。
 *
 * 钉住的点：
 * 1. **sizeBytes 用读出来的真实字节长度**（mock 读出 4 字节，声明值故意给 99 ——
 *    两边相等时断言分不出实现用的是哪个）；
 * 2. **PUT 显式带 content-type**（对象存储把 PUT 的 Content-Type 落成对象 mime，
 *    confirm 按真实字节复核 MIME）；
 * 3. **三步之间逐步问 isActive**：弹层已关 / 条目已移除后，还没发的那一步不再发
 *    （confirm 出一个永不引用的公开对象就是孤儿）。
 */

type ApiCall = { path: string; method?: string; body?: unknown }
type UploadCall = { url: string; method?: string; header?: Record<string, string> }

const apiCalls: ApiCall[] = []
const uploads: UploadCall[] = []

let presignResponse: unknown = null
let confirmResponse: unknown = null
let uploadStatus = 200

/** 「本地文件已读完」时执行的钩子（读后判据发生翻转的时刻） */
let duringRead: (() => void) | null = null
/** 「直传 PUT 已发完」时执行的钩子（PUT 后、confirm 前翻转判据的时刻） */
let duringUpload: (() => void) | null = null

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
      duringUpload?.()
      return { statusCode: uploadStatus }
    },
  },
}))

mock.module('@/lib/request', () => ({
  apiRequest: async (path: string, options?: Omit<ApiCall, 'path'>) => {
    apiCalls.push({ path, ...options })
    if (path.includes('/media/presign')) return presignResponse
    return confirmResponse
  },
}))

const { uploadReviewImage } = await import('../src/features/transaction/review-media')

const TX = '01930000-0000-7000-8000-00000000c0de'
const STAGING_KEY = 'transaction-review-media/usr_01/med_01.png'
const FINAL_KEY = 'reviews/usr_01/med_01.png'

/** 与 mock 读出来的 4 字节**故意不同**：断言 presign 声明的是真实字节长度 */
const PHOTO = { path: 'wxfile://tmp/pick.png', mime: 'image/png', sizeBytes: 99 }

beforeEach(() => {
  apiCalls.length = 0
  uploads.length = 0
  uploadStatus = 200
  duringRead = null
  duringUpload = null
  presignResponse = {
    uploadUrl: 'http://localhost:9000/fish/transaction-review-media/usr_01/med_01.png',
    objectKey: STAGING_KEY,
    headers: {},
    expiresAt: '2026-01-01T00:00:00.000Z',
  }
  confirmResponse = { objectKey: FINAL_KEY, url: 'https://api.example.com/api/uploads/media/tok' }
})

describe('uploadReviewImage —— 三步编排（#475）', () => {
  test('presign → PUT → confirm，返回 confirm 固化的 final 键（不是 staging 键）', async () => {
    const key = await uploadReviewImage(TX, PHOTO)
    expect(key).toBe(FINAL_KEY)

    expect(apiCalls[0]?.path).toBe(TRANSACTION_REVIEW_ROUTES.mediaPresign(TX))
    expect(apiCalls[0]?.method).toBe('POST')
    // 声明值是**读出来的真实字节长度**（4），不是选图器给的 99
    expect(apiCalls[0]?.body).toEqual({ contentType: 'image/png', sizeBytes: 4 })

    expect(apiCalls[1]?.path).toBe(TRANSACTION_REVIEW_ROUTES.mediaConfirm(TX))
    // confirm 的入参是 presign 回的 staging 键（它自己都不知道 final 键长什么样）
    expect(apiCalls[1]?.body).toEqual({ objectKey: STAGING_KEY })
  })

  test('PUT 直传带显式 content-type，地址与头来自 presign', async () => {
    await uploadReviewImage(TX, PHOTO)
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.url).toBe(
      'http://localhost:9000/fish/transaction-review-media/usr_01/med_01.png',
    )
    expect(uploads[0]?.method).toBe('PUT')
    expect(uploads[0]?.header?.['content-type']).toBe('image/png')
  })

  test('PUT 非 2xx：报「图片上传失败」，且不发 confirm（别把半成品固化成可引用键）', async () => {
    uploadStatus = 500
    await expect(uploadReviewImage(TX, PHOTO)).rejects.toThrow('图片上传失败')
    expect(apiCalls).toHaveLength(1)
  })
})

describe('uploadReviewImage —— 在途闸（逐步问 isActive）', () => {
  test('读文件回来时判据已翻假：中止，presign 与 PUT 都不发', async () => {
    let active = true
    duringRead = () => {
      active = false
    }
    await expect(uploadReviewImage(TX, PHOTO, () => active)).rejects.toThrow()
    expect(apiCalls).toHaveLength(0)
    expect(uploads).toHaveLength(0)
  })

  test('直传回来时判据已翻假：不发 confirm（staging 对象留给孤儿回收，不再固化）', async () => {
    let active = true
    duringUpload = () => {
      active = false
    }
    await expect(uploadReviewImage(TX, PHOTO, () => active)).rejects.toThrow()
    // presign 与 PUT 都已发出，confirm 必须没有
    expect(apiCalls).toHaveLength(1)
    expect(uploads).toHaveLength(1)
    expect(apiCalls.some((call) => call.path === TRANSACTION_REVIEW_ROUTES.mediaConfirm(TX))).toBe(
      false,
    )
  })

  test('判据一直为真：三步走完', async () => {
    const active = true
    await expect(uploadReviewImage(TX, PHOTO, () => active)).resolves.toBe(FINAL_KEY)
    expect(apiCalls).toHaveLength(2)
    expect(uploads).toHaveLength(1)
  })
})
