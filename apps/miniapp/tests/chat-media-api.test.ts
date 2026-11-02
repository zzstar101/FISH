import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import { MEDIA_MAX_VOICE_DURATION_MS } from '@fish/contracts/chat/schema'

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

/**
 * 录音机的回调与最近一次 `start` 的入参。
 *
 * 回调**不能**在 `beforeEach` 里清空：`media-api` 的 `RecorderManager` 是模块级单例、
 * `onStop` / `onError` 只注册一次，清掉就再也接不上了。
 */
const recorderHooks: {
  onError: ((error: { errMsg: string }) => void) | null
} = { onError: null }
let recorderStartOptions: { duration?: number } | null = null
/** `readFile` 每次返回的字节；语音容器用例按需替换，图片用例保持 4 字节 */
let readBytes = [1, 2, 3, 4]

mock.module('@tarojs/taro', () => ({
  default: {
    getFileSystemManager: () => ({
      readFile: (option: { filePath: string; success: (res: { data: unknown }) => void }) => {
        option.success({ data: new Uint8Array(readBytes).buffer })
        duringRead?.()
      },
    }),
    getRecorderManager: () => ({
      onStop: () => undefined,
      onError: (handler: (error: { errMsg: string }) => void) => {
        recorderHooks.onError = handler
      },
      start: (options: { duration?: number }) => {
        recorderStartOptions = options
      },
      stop: () => undefined,
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
const {
  cachedMediaPath,
  clearMediaCache,
  downloadChatMedia,
  MediaUploadError,
  startVoiceRecording,
  uploadChatImage,
  uploadChatVoice,
  VoiceContainerError,
  VoicePermissionError,
  VoicePrivacyError,
  voiceError,
} = await import('../src/features/chat/media-api')

const CONVERSATION = '01930000-0000-7000-8000-000000000041'
const MEDIA = '01930000-0000-7000-8000-0000000000a1'

const IMAGE = {
  path: 'wxfile://tmp/pick.png',
  mime: 'image/png' as const,
  width: 600,
  height: 400,
  /**
   * 故意与 mock 读出来的字节数（4）**不同**（#364 审查回合二）：需求是「`sizeBytes` 取
   * 读出来的真实字节长度」，两边相等时断言分不出实现用的是声明值还是真实值。
   */
  sizeBytes: 99,
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
  recorderStartOptions = null
  readBytes = [1, 2, 3, 4]
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

  test('身份一直有效：presign → PUT（显式带 content-type）→ sizeBytes 取真实字节、尺寸取调用方声明', async () => {
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

describe('uploadChatVoice —— 容器不可识别时必须在 presign 前失败且可诊断（#516）', () => {
  /** 裸 ADTS（AAC）头：微信 Android / 开发者工具下的常见回落，契约白名单不收 */
  const ADTS = [0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]
  /** 最小 RIFF/WAVE 头：只够 `voiceMimeFromBytes` 判定容器 */
  const RIFF_WAV = [
    0x52,
    0x49,
    0x46,
    0x46, // RIFF
    0x24,
    0x00,
    0x00,
    0x00, // chunk size
    0x57,
    0x41,
    0x56,
    0x45, // WAVE
  ]

  test('ADTS：抛 VoiceContainerError，size/header 可取证，且一个请求都不发', async () => {
    readBytes = ADTS
    const error = await uploadChatVoice(CONVERSATION, {
      path: 'wxfile://tmp/voice.aac',
      durationMs: 1200,
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(VoiceContainerError)
    expect((error as VoiceContainerError).sizeBytes).toBe(ADTS.length)
    expect((error as VoiceContainerError).header).toContain('ff f1')
    expect((error as VoiceContainerError).message).toBe('当前录音格式暂不支持发送语音')
    // 锁住「容器判定必须在 presign 之前」：不是本 PR 新引入的回归，而是既有约束。
    expect(apiCalls).toHaveLength(0)
    expect(uploads).toHaveLength(0)
  })

  test('RIFF/WAVE：正常 presign → PUT，content-type 是 audio/wav', async () => {
    readBytes = RIFF_WAV
    const uploaded = await uploadChatVoice(
      CONVERSATION,
      { path: 'wxfile://tmp/voice.wav', durationMs: 1200 },
      () => true,
    )

    expect(apiCalls[0]?.body).toEqual({
      kind: 'VOICE',
      contentType: 'audio/wav',
      sizeBytes: RIFF_WAV.length,
    })
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.header).toEqual({ 'content-type': 'audio/wav' })
    expect(uploaded).toEqual({
      kind: 'VOICE',
      objectKey: `chat-media/${CONVERSATION}/me/1.png`,
      contentType: 'audio/wav',
      sizeBytes: RIFF_WAV.length,
      durationMs: 1200,
    })
  })

  test('PUT 非 2xx：抛 MediaUploadError，保留 HTTP 状态且文案不暴露状态码', async () => {
    readBytes = RIFF_WAV
    uploadStatus = 503
    const error = await uploadChatVoice(CONVERSATION, {
      path: 'wxfile://tmp/voice.wav',
      durationMs: 1200,
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(MediaUploadError)
    expect((error as MediaUploadError).statusCode).toBe(503)
    expect((error as MediaUploadError).message).toBe('语音发送失败，请重试')
  })
})

describe('startVoiceRecording —— 失败立刻上报 + 时长留余量（#364 审查）', () => {
  test('录音上限比契约上限小：服务端严格大于即 422，而 WAV 时长是精确值', () => {
    startVoiceRecording()
    expect(recorderStartOptions?.duration).toBeDefined()
    // 修复前这里就是契约上限本身（60000）：录音机收尾时多补一帧算出的 60004ms
    // 正好越过服务端的 `> MEDIA_MAX_VOICE_DURATION_MS`，录满一分钟反而发不出去。
    expect(recorderStartOptions?.duration ?? 0).toBeLessThan(MEDIA_MAX_VOICE_DURATION_MS)
  })

  test('录音进行中 onError：不等用户松手就上报，且是能走「去设置」的权限错误', () => {
    const reported: Error[] = []
    startVoiceRecording((error) => reported.push(error))

    recorderHooks.onError?.({ errMsg: 'operateRecorder:fail auth deny' })

    // 修复前 `startVoiceRecording` 不收回调：这个错误要等到用户松手、`stop()` 的
    // catch 才被看到，期间按钮一直写着「松开 发送」，实际什么都没在录。
    // （顺带锁住「错误已带外上报时就没人接 `done` 的 rejection」：漏了这条，本用例
    // 会因为未处理的 Promise 拒绝而变红。）
    expect(reported).toHaveLength(1)
    expect(reported[0]).toBeInstanceOf(VoicePermissionError)
  })

  test('onError 在 stop() 之后才到：交给 stop() 的 catch 上报一次，不重复弹', async () => {
    const reported: Error[] = []
    const session = startVoiceRecording((error) => reported.push(error))

    const stopped = session.stop()
    recorderHooks.onError?.({ errMsg: 'operateRecorder:fail system error' })

    await expect(stopped).rejects.toThrow('录音失败，请重试')
    expect(reported).toHaveLength(0)
  })
})

describe('voiceError —— 权限被拒必须与普通失败可区分', () => {
  test('隐私授权错误不会被误判成麦克风权限错误', () => {
    const error = voiceError({
      errMsg: 'operateRecorder:fail privacy permission is not authorized',
    })
    expect(error).toBeInstanceOf(VoicePrivacyError)
    expect(error).not.toBeInstanceOf(VoicePermissionError)
    expect(error.message).toContain('隐私保护指引')
  })

  test('权限 / auth 类错误：VoicePermissionError（页面据此给「去设置」）', () => {
    const error = voiceError({ errMsg: 'operateRecorder:fail auth deny' })
    expect(error).toBeInstanceOf(VoicePermissionError)
    expect(error.message).toBe('需要麦克风权限才能发语音')
  })

  test('已经是权限错误时再归一化一次不许降级（否则页面永远进不去「去设置」）', () => {
    /*
      错误会被归一化两遍：`onError` 里先 `voiceError(平台错误)` 得到 VoicePermissionError，
      页面拿到后（`handleVoiceFailure`）还会再调一次 `voiceError`。而 VoicePermissionError
      是普通 Error 子类、没有 `errMsg` —— 修复前这里会降级成「录音失败，请重试」，
      页面的 `instanceof VoicePermissionError` 判据恒假，「去设置」分支不可达。
    */
    expect(voiceError(new VoicePermissionError())).toBeInstanceOf(VoicePermissionError)
    // 普通错误仍旧照常归一化（不能因为这条特例把通用文案也放过）
    expect(voiceError(new Error('录音失败，请重试')).message).toBe('录音失败，请重试')
  })

  test('其它失败：普通 Error，页面只提示、不拉设置页', () => {
    const error = voiceError({ errMsg: 'operateRecorder:fail system error' })
    expect(error).not.toBeInstanceOf(VoicePermissionError)
    expect(error.message).toBe('录音失败，请重试')
  })
})
