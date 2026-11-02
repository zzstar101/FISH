import { beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test'
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
type UploadCall = {
  url: string
  method?: string
  header?: Record<string, string>
  data?: ArrayBuffer
}

const apiCalls: ApiCall[] = []
const uploads: UploadCall[] = []
const downloads: { url: string; header?: Record<string, string> }[] = []

let presignResponse: unknown = null
let localFile = new Uint8Array([1, 2, 3, 4]).buffer
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
  onStop: ((result: { tempFilePath: string; duration: number }) => void) | null
  /** 录音被系统占用打断（来电 / 视频通话）：平台是 `onInterruptionBegin` */
  onInterruptionBegin: (() => void) | null
  onInterruptionEnd: (() => void) | null
} = {
  onError: null,
  onStop: null,
  onInterruptionBegin: null,
  onInterruptionEnd: null,
}
let recorderStartOptions: { duration?: number } | null = null
/** `RecorderManager.start()` 被调用了几次：单例同一时刻只许交给一段录音 */
let recorderStartCalls = 0
/**
 * `RecorderManager.stop()` 被调用了几次：用来钉住「中断结束后只对这一段的账催一次」，
 * 也就是「催终态事件」不许变成「换一种解闸方式」。
 */
let recorderStopCalls = 0
/** `stop()` 抛错（平台异常）：验证放弃的账目不会毒化下一段录音 */
let stopThrows = false
/** `start()` 同步抛错（平台异常）：验证失败那一次不占账 */
let startThrows = false

mock.module('@tarojs/taro', () => ({
  default: {
    getFileSystemManager: () => ({
      readFile: (option: { filePath: string; success: (res: { data: unknown }) => void }) => {
        option.success({ data: localFile })
        duringRead?.()
      },
    }),
    getRecorderManager: () => ({
      onStop: (handler: (result: { tempFilePath: string; duration: number }) => void) => {
        recorderHooks.onStop = handler
      },
      onError: (handler: (error: { errMsg: string }) => void) => {
        recorderHooks.onError = handler
      },
      onInterruptionBegin: (handler: () => void) => {
        recorderHooks.onInterruptionBegin = handler
      },
      onInterruptionEnd: (handler: () => void) => {
        recorderHooks.onInterruptionEnd = handler
      },
      start: (options: { duration?: number }) => {
        if (startThrows) throw new Error('operateRecorder:fail start')
        recorderStartCalls += 1
        recorderStartOptions = options
      },
      stop: () => {
        recorderStopCalls += 1
        if (stopThrows) throw new Error('operateRecorder:fail stop')
      },
    }),
    request: async (option: UploadCall) => {
      uploads.push({ ...option })
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
  VoiceRecordingBusyError,
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
  localFile = new Uint8Array([1, 2, 3, 4]).buffer
  uploadStatus = 200
  downloadStatus = 200
  recorderStartOptions = null
  recorderStartCalls = 0
  recorderStopCalls = 0
  stopThrows = false
  startThrows = false
  presignResponse = {
    uploadUrl: 'http://localhost:9000/fish/chat-media/up',
    objectKey: `chat-media/${CONVERSATION}/me/1.png`,
    headers: {},
    expiresAt: '2026-01-01T00:00:00.000Z',
  }
  /*
    账目跨用例存活（`RecorderManager` 是模块级单例，回调只注册一次）。上一段还在等收尾时
    不许起录下一段（#549），所以每个用例开头先把残局的收尾事件送回去让账目归零；账上本来
    没有东西时这个事件被直接忽略。
  */
  recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/leftover.wav', duration: 0 })
})

describe('uploadChatVoice —— #542 已取证 WAV 头部规范化', () => {
  test('只纠正已知 PCM 头，再把完整字节交给 PUT；原文件与 payload 不变', async () => {
    localFile = await Bun.file(
      new URL('./fixtures/542-voice-silence.wav', import.meta.url),
    ).arrayBuffer()
    // 非零合成采样值：避免全静音掩盖实现意外清空 payload。
    new Uint8Array(localFile).set([0x12, 0x34], 44)
    const original = localFile.slice(0)
    const result = await uploadChatVoice(CONVERSATION, {
      path: 'wxfile://tmp/voice.wav',
      durationMs: 9999,
    })
    expect(uploads).toHaveLength(1)
    const uploaded = uploads[0]?.data
    expect(uploaded).toBeDefined()
    if (!uploaded) throw new Error('missing PUT body')
    const header = new DataView(uploaded)
    expect(header.getUint32(4, true)).toBe(43404)
    expect(header.getUint32(40, true)).toBe(43368)
    expect(header.getUint16(32, true)).toBe(2)
    expect(new Uint8Array(uploaded).subarray(44)).toEqual(new Uint8Array(original).subarray(44))
    expect(new Uint8Array(localFile)).toEqual(new Uint8Array(original))
    expect(uploaded.byteLength).toBe(43412)
    expect(apiCalls[0]?.body).toEqual({ kind: 'VOICE', contentType: 'audio/wav', sizeBytes: 43412 })
    expect(uploads[0]?.header?.['content-type']).toBe('audio/wav')
    expect(result).toMatchObject({ contentType: 'audio/wav', sizeBytes: 43412, durationMs: 9999 })
  })
})

describe('uploadChatVoice —— 不猜修其他字节形状', () => {
  const fields = [
    { name: 'fmt chunk 大小', offset: 16, value: 18, width: 4 },
    { name: '非 PCM', offset: 20, value: 3, width: 2 },
    { name: '双声道', offset: 22, value: 2, width: 2 },
    { name: '采样率', offset: 24, value: 8000, width: 4 },
    { name: 'byteRate', offset: 28, value: 16000, width: 4 },
    { name: 'blockAlign 已为 2', offset: 32, value: 2, width: 2 },
    { name: '位宽', offset: 34, value: 8, width: 2 },
    { name: '只有 RIFF 长度异常', offset: 40, value: 43368, width: 4 },
    { name: '只有 data 长度异常', offset: 4, value: 43404, width: 4 },
    { name: 'RIFF 占位值', offset: 4, value: 0xffffffff, width: 4 },
    { name: '非 fmt chunk', offset: 12, value: 0, width: 4 },
    { name: '非 data chunk', offset: 36, value: 0, width: 4 },
  ]
  test.each(fields)('$name 时原样上传，仍由服务端判定', async ({ offset, value, width }) => {
    localFile = await Bun.file(
      new URL('./fixtures/542-voice-silence.wav', import.meta.url),
    ).arrayBuffer()
    const header = new DataView(localFile)
    if (width === 2) header.setUint16(offset, value, true)
    else header.setUint32(offset, value, true)
    // 快照必须在上传**之前**取：只比引用（`toBe`）证明不了「原样上传」——原地改写字节的
    // 实现会把 localFile 一起改掉，引用比较照样通过（#550 审查：此前的断言正是如此）。
    const snapshot = new Uint8Array(localFile.slice(0))
    await uploadChatVoice(CONVERSATION, { path: 'wxfile://tmp/voice.wav', durationMs: 1000 })
    const uploaded = uploads[0]?.data
    expect(uploaded).toBeDefined()
    if (!uploaded) throw new Error('missing PUT body')
    // 输入逐字节不变 + 上传体逐字节等于快照：两条合起来才排除「顺手猜修」。
    expect(new Uint8Array(localFile)).toEqual(snapshot)
    expect(new Uint8Array(uploaded)).toEqual(snapshot)
  })

  test.each(['normal', 'empty', 'odd', 'short', 'mp4', 'webm'])('%s 文件不变', async (shape) => {
    localFile = await Bun.file(
      new URL('./fixtures/542-voice-silence.wav', import.meta.url),
    ).arrayBuffer()
    if (shape === 'normal') {
      const header = new DataView(localFile)
      header.setUint32(4, localFile.byteLength - 8, true)
      header.setUint32(40, localFile.byteLength - 44, true)
      header.setUint16(32, 2, true)
    } else if (shape === 'empty' || shape === 'odd') {
      localFile = localFile.slice(0, shape === 'empty' ? 44 : localFile.byteLength - 1)
      const header = new DataView(localFile)
      header.setUint32(4, localFile.byteLength + 36, true)
      header.setUint32(40, localFile.byteLength, true)
    } else if (shape === 'short') localFile = localFile.slice(0, 42)
    else if (shape === 'mp4')
      localFile = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 0, 0, 0, 0]).buffer
    else if (shape === 'webm') localFile = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]).buffer
    const before = localFile.slice(0)
    await uploadChatVoice(CONVERSATION, { path: 'wxfile://tmp/voice', durationMs: 1000 })
    expect(uploads[0]?.data).toBe(localFile)
    expect(new Uint8Array(localFile)).toEqual(new Uint8Array(before))
  })
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
    localFile = new Uint8Array(ADTS).buffer
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
    localFile = new Uint8Array(RIFF_WAV).buffer
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
    localFile = new Uint8Array(RIFF_WAV).buffer
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

  test('录音器自己停（没人调 stop）→ onAutoStop 触发一次，并区分「录满」与「被打断」（#535）', () => {
    const calls: Array<{ durationMs: number; capped: boolean }> = []
    startVoiceRecording(undefined, (recorded, capped) => {
      calls.push({ durationMs: recorded.durationMs, capped })
    })

    // 录满：时长贴着上限（VOICE_RECORD_MAX_MS = 契约上限 - 1s = 59000）
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/voice.wav', duration: 59_000 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.capped).toBe(true)

    // 被系统打断：时长离上限很远 → 不该被当成「录满」
    startVoiceRecording(undefined, (recorded, capped) => {
      calls.push({ durationMs: recorded.durationMs, capped })
    })
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/voice.wav', duration: 5_000 })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.capped).toBe(false)
  })

  test('stop() 之后才到的 onStop 不触发 onAutoStop（否则同一段会发两次）', async () => {
    const calls: number[] = []
    const session = startVoiceRecording(undefined, () => calls.push(1))

    const stopped = session.stop()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/voice.wav', duration: 3_000 })

    await expect(stopped).resolves.toEqual({
      path: 'wxfile://tmp/voice.wav',
      durationMs: 3_000,
    })
    expect(calls).toHaveLength(0)
  })

  test('onError 在 stop() 之后才到：交给 stop() 的 catch 上报一次，不重复弹', async () => {
    const reported: Error[] = []
    const session = startVoiceRecording((error) => reported.push(error))

    const stopped = session.stop()
    recorderHooks.onError?.({ errMsg: 'operateRecorder:fail system error' })

    await expect(stopped).rejects.toThrow('录音失败，请重试')
    expect(reported).toHaveLength(0)
  })

  /*
    #535 复审 medium：「录满」不该只看时长阈值 —— 时长判据分不出「录到上限」与
    「被打断」。平台有真正的信号（`RecorderManager.onInterruptionBegin`：来电 /
    视频通话占用麦克风），中断标记必须参与判定，否则 58.5s 之后被打断的半句会被
    当成「录满」自动发给对方。

    这条守的是**不接 `onInterrupted` 的调用方**（#549 Quality 审查 L1）：真实接线里页面
    收到通知当场 `abort()`，此后 `liveSession()` 对这一段返回 undefined，`voiceCapped` 的
    中断判据在那条路径上跑不到 —— 这里不传第三个回调，正是为了覆盖它仍然生效的形态。
  */
  test('被系统打断后自停（59s 上限前的最后 500ms）：不算「录满」，不自动发送', () => {
    const calls: Array<{ durationMs: number; capped: boolean }> = []
    startVoiceRecording(undefined, (recorded, capped) => {
      calls.push({ durationMs: recorded.durationMs, capped })
    })

    recorderHooks.onInterruptionBegin?.()
    // 58.9s：只按时长判据（>= 58.5s）会判成「录满」→ 自动发送被截断的音频
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/cut.wav', duration: 58_900 })

    expect(calls).toEqual([{ durationMs: 58_900, capped: false }])
  })

  // 同上的调用方形态：不接 `onInterrupted`（真实接线里中断当场 abort，跑不到这里）
  test('中断结束后继续录满：仍按「录满」处理（中断标记不外溢到正常收尾）', () => {
    const calls: Array<{ capped: boolean }> = []
    startVoiceRecording(undefined, (_recorded, capped) => calls.push({ capped }))

    recorderHooks.onInterruptionBegin?.()
    recorderHooks.onInterruptionEnd?.()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/voice.wav', duration: 59_000 })

    expect(calls).toEqual([{ capped: true }])
  })
})

/*
  #549（#535 follow-up 的 F1/F2 收口）：`RecorderManager` 是**全局单例**，`onStop` / `onError`
  都**不带 session id** —— 平台只在「这一次 `start()` 对应的那一段录音」上投事件。

  修复前允许「上一段还在等收尾」时又起录下一段，单例上于是同时挂着两段，任何一条不带标识的
  回调都只能靠猜：猜「谁起录过」（`onStart`）、猜「谁叫过 stop」，都会在某个到达顺序下把结果
  交给错的那一段 —— 上一段的 `stop` 失败会打死正在录的那一段（面板消失、麦克风还在录），
  上一段的音频会被当成新一段「录满」发出去。而 `onStart` 只是「录音开始事件」，官方没有承诺
  「起录失败的那一段永远不投 onStart」；时间戳 / 账龄 / TTL 更与「这条回调属于谁」无关。
  换一种猜法不解决问题。

  正确的约束不是换猜法，而是让猜没有素材：**单例同一时刻只交给一段录音**。上一段还没把自己
  的收尾事件（`onStop` / `onError`）交回来时，新的起录被**拒绝**（`VoiceRecordingBusyError`），
  平台 `start()` 根本不会被第二次调用 —— 于是「这条回调属于谁」永远只有唯一答案。
*/
describe('startVoiceRecording —— 单例同一时刻只交给一段录音（#549）', () => {
  test('上一段还没终结（已 stop、onStop 未到）：新起录被拒绝，录音器不会被第二次占用', () => {
    const first = startVoiceRecording()
    first.stop()
    const startsBefore = recorderStartCalls

    let refused: unknown = null
    try {
      startVoiceRecording()
    } catch (error) {
      refused = error
    }

    // 修复前这里不抛错，`start()` 被第二次调用 —— 单例上同时挂着两段，之后每条不带标识的
    // 回调都只能靠猜（F1 就是猜错的那一半）。
    expect(recorderStartCalls).toBe(startsBefore)
    expect(refused).toBeInstanceOf(VoiceRecordingBusyError)
    // 拒绝的理由要能直接说给用户听，不能退化成「录音失败，请重试」
    expect(voiceError(refused).message).toContain('还在收尾')
  })

  test('上一段的 stop 失败只归上一段：它自己 reject，残局事件不冒充下一段，之后照常录', async () => {
    const firstErrors: Error[] = []
    const first = startVoiceRecording((error) => firstErrors.push(error))
    const firstStopped = first.stop()

    // 用户在上一段收尾前又按了一次：新的一段根本起不来（单例还被上一段占着）
    expect(() => startVoiceRecording()).toThrow()

    // 这条错误是上一段自己的 stop 失败 → 走 `stop()` 的 catch 上报一次
    recorderHooks.onError?.({ errMsg: 'operateRecorder:fail system error' })
    await expect(firstStopped).rejects.toThrow('录音失败，请重试')
    expect(firstErrors).toHaveLength(0)

    // 单例空出来了：这次按下真能录，并且**只**拿到自己的音频（不是上一段那笔）
    const autoStops: string[] = []
    const second = startVoiceRecording(undefined, () => autoStops.push('second-auto'))
    const secondStopped = second.stop()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/second.wav', duration: 2_000 })
    await expect(secondStopped).resolves.toEqual({
      path: 'wxfile://tmp/second.wav',
      durationMs: 2_000,
    })
    // 第二段是被人叫停的，不该再收到一次「自停」通知（同一段会发两次）
    expect(autoStops).toEqual([])
  })

  test('取消（abort）后收尾未到：同样不许叠第二段；收尾到了才放行', () => {
    const cancelled = startVoiceRecording()
    cancelled.abort()

    expect(() => startVoiceRecording()).toThrow()

    // 放弃的那一段自己的收尾到了：不交付，但账要销、单例要放行
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/cancelled.wav', duration: 8_000 })
    const live = startVoiceRecording()
    const stopped = live.stop()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/live.wav', duration: 2_000 })
    return expect(stopped).resolves.toEqual({ path: 'wxfile://tmp/live.wav', durationMs: 2_000 })
  })

  test('起录时 start() 同步抛错：当场销账，不把录音器锁死', () => {
    startThrows = true
    expect(() => startVoiceRecording()).toThrow('operateRecorder:fail start')
    startThrows = false

    const session = startVoiceRecording()
    const stopped = session.stop()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/after.wav', duration: 1_000 })
    return expect(stopped).resolves.toEqual({ path: 'wxfile://tmp/after.wav', durationMs: 1_000 })
  })

  test('放弃的那一段：自己的 onStop / onError 到了也不交付', () => {
    const autoStops: string[] = []
    const reported: Error[] = []

    const cancelled = startVoiceRecording(
      (error) => reported.push(error),
      () => autoStops.push('auto'),
    )
    cancelled.abort()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/cancelled.wav', duration: 8_000 })

    const errored = startVoiceRecording(
      (error) => reported.push(error),
      () => autoStops.push('auto'),
    )
    errored.abort()
    recorderHooks.onError?.({ errMsg: 'operateRecorder:fail system error' })

    expect(autoStops).toEqual([])
    expect(reported).toEqual([])
  })

  /*
    `stop()` / `abort()` **同步抛错**说明「这条命令没被平台接受」，但它**不说明**平台已经
    收尾：录音可能还在走（那这一段的 `onStop` 迟早会来），也可能它已经自己停了、事件还在路上。
    两种情况下这一段的收尾事件都可能**晚于**下一次起录到达 —— 那就正是单槽记账要拦住的
    「两段同时挂账」。所以这里不许因为「抛错了」就当场销账：#549 的收口判据要求
    **要么拿平台证据，要么 fail-closed**，本仓拿不到「抛错 ⇒ 不会再有事件」的证据。
  */
  test('abort 的 stop() 抛错：账目留着（不猜「不会再有收尾事件」），真正收尾到了才放行', () => {
    const calls: string[] = []

    const ghost = startVoiceRecording(undefined, () => calls.push('ghost'))
    stopThrows = true
    ghost.abort()
    stopThrows = false

    // 修复前：这里当场销账 → 下一段立刻起得来，随后「幽灵收尾」就落到它头上
    expect(() => startVoiceRecording(undefined, () => calls.push('next'))).toThrow(
      VoiceRecordingBusyError,
    )

    // 放弃的段自己的收尾到了：不交付、不通知，但账要销、单例要放行
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/ghost.wav', duration: 8_000 })
    expect(calls).toEqual([])

    const next = startVoiceRecording(undefined, () => calls.push('next'))
    const stopped = next.stop()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/next.wav', duration: 2_000 })
    return expect(stopped).resolves.toEqual({ path: 'wxfile://tmp/next.wav', durationMs: 2_000 })
  })

  test('松手时 stop() 抛错：失败走 promise，但账目留着等真正的收尾事件', async () => {
    const ghost = startVoiceRecording()
    stopThrows = true
    const stopped = ghost.stop()
    stopThrows = false

    /*
      两条要求同时成立：
      1. 失败必须以 **promise** 交出去（同步抛出的话页面 `session.stop().then().catch()`
         这条链根本没建立，异常一路冒到触摸事件处理里没人接）；
      2. 账目**不能**当场销 —— 这一次录音到底停没停，抛错不能作证。
    */
    await expect(stopped).rejects.toThrow('录音失败，请重试')
    expect(() => startVoiceRecording()).toThrow(VoiceRecordingBusyError)

    // 真正的收尾到了：这段已经由 `stop()` 的失败交付过，不再当成「自停」发第二次
    const autoStops: number[] = []
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/ghost.wav', duration: 59_000 })
    expect(autoStops).toEqual([])

    const next = startVoiceRecording(undefined, (recorded) => autoStops.push(recorded.durationMs))
    const nextStopped = next.stop()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/next.wav', duration: 59_000 })
    await expect(nextStopped).resolves.toEqual({
      path: 'wxfile://tmp/next.wav',
      durationMs: 59_000,
    })
  })

  /*
    #549 收口判据 3：收尾事件**永远不来**时，行为是 fail-closed（不猜时间、不 TTL 放行），
    但用户侧必须看得到「怎么办」—— 一直只弹「稍后再按」等于把用户困在死循环里。
    这里只升级**文案**：账目一个字节都不动，闸门照旧关着。
  */
  test('收尾事件迟迟不来：账不擅自放行，但拒绝文案升级成可执行的恢复提示', () => {
    const first = startVoiceRecording()
    first.stop()

    // 已经过了「这一段最迟该收到收尾事件」的时刻（录音上限 59s + 5s 余量）
    setSystemTime(new Date(Date.now() + 59_000 + 5_000 + 1))
    const startedBefore = recorderStartCalls
    let refused: unknown = null
    try {
      startVoiceRecording()
    } catch (error) {
      refused = error
    }
    setSystemTime()

    expect(recorderStartCalls).toBe(startedBefore)
    expect(refused).toBeInstanceOf(VoiceRecordingBusyError)
    // 文案必须给出恢复动作，而不是让用户无限重按
    expect((refused as Error).message).toContain('重新打开')
  })

  /*
    需求 4 的「中断」失效路径：来电 / 视频通话把录音暂停了（`onInterruptionBegin`），这一段
    音频已经是截断的。修复前平台信号只被记成一个布尔，页面在录音期间完全不知道发生过什么 ——
    提示要等到松手（或被平台自停）才出现，而那时用户已经又对着面板说了半分钟。
    现在中断信号立刻带外通知页面：放弃这一段 + 复位面板 + 明确提示重录。
  */
  test('来电中断：立刻带外通知一次（页面据此放弃这一段），收尾事件到了也不交付', () => {
    const events: string[] = []
    const autoStops: string[] = []
    let session: ReturnType<typeof startVoiceRecording> | null = null
    session = startVoiceRecording(
      () => events.push('error'),
      () => autoStops.push('auto'),
      () => {
        events.push('interrupted')
        // 页面收到通知的处置（与 index.tsx 的 `handleVoiceInterrupted` 一致）：放弃这一段
        session?.abort()
      },
    )

    recorderHooks.onInterruptionBegin?.()
    expect(events).toEqual(['interrupted'])
    // 中断开始的那一刻仍然是「当前中断态」（松手竞态兜底用得上）
    expect(session.wasInterrupted()).toBe(true)

    // 被放弃的那一段自己的收尾到了：不交付、不通知
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/cut.wav', duration: 20_000 })
    expect(events).toEqual(['interrupted'])
    expect(autoStops).toEqual([])
  })

  test('正常收尾窗口内（几十毫秒级）仍然是「稍后再按」，不要拿大词吓用户', () => {
    const first = startVoiceRecording()
    first.stop()

    let refused: unknown = null
    try {
      startVoiceRecording()
    } catch (error) {
      refused = error
    }

    expect(refused).toBeInstanceOf(VoiceRecordingBusyError)
    expect((refused as Error).message).toContain('还在收尾')
  })

  /*
    #549 收口判据 2：「中断发生过」与「当前仍处于中断态」是两件事。
    - 当前态（`interrupted`）参与「录满」判定与松手投递判定；
    - 历史不外溢：中断结束（`onInterruptionEnd`）之后这一段恢复正常，**下一段**更是干净开局。
  */
  test('中断只在「当前仍处于中断态」时可见：中断结束即恢复，且不外溢到下一段', () => {
    const autoStops: Array<{ durationMs: number; capped: boolean }> = []
    const first = startVoiceRecording(undefined, (recorded, capped) => {
      autoStops.push({ durationMs: recorded.durationMs, capped })
    })
    expect(first.wasInterrupted()).toBe(false)

    recorderHooks.onInterruptionBegin?.()
    expect(first.wasInterrupted()).toBe(true)

    // 中断结束 = 录音恢复：历史标记不许留下来当持续状态
    recorderHooks.onInterruptionEnd?.()
    expect(first.wasInterrupted()).toBe(false)

    // 恢复后录满 59s：仍按「录满」自动发送（修复前若改成「中断过一次就永久不算录满」，
    // 一次已经恢复的 59s 正常录音会被误判成「被打断」而不发）
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/full.wav', duration: 59_000 })
    expect(autoStops).toEqual([{ durationMs: 59_000, capped: true }])

    // 下一段干净开局：上一段的中断历史一个字都不带
    const second = startVoiceRecording()
    expect(second.wasInterrupted()).toBe(false)
    second.abort()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/second.wav', duration: 1_000 })
  })

  /*
    #549 独立 Spec 审查 M2 + Quality 审查 M1：中断（`onInterruptionBegin`）→ 页面当场
    `abort()` 之后，这一段的账只能靠**平台补发终态事件**销。而 `onInterruptionEnd` 虽然是
    「录音已恢复」的平台证据，却**不是**这一段的终态事件 —— 修复前它对已放弃的段完全无效
    （`liveSession()` 对它返回 undefined），所以平台若一直不补 `onStop` / `onError`，闸门就
    关到重开小程序。

    允许的补救只有一条：对**这一段自己的账**再补一次 `stop()`，把终态事件催回来；闸门
    **仍然只由终态事件打开**。绝不许提前把 `voiceSession` 置空 —— 那样平台随后补发的
    `onStop` 会去清**下一段**的槽（正是单槽记账要防的「上一段收尾打死新一段」）。

    补发不设时间窗（Quality 审查 M1）：`onInterruptionEnd` 对一段录音只来**一次**，而
    `stopRequestedAtMs` 记的是**中断开始**的时刻，所以任何「等过了 X 毫秒再补发」的判据实际
    比较的是「中断持续了多久」—— 短中断（来电一秒挂断、快速切后台，恰恰是最常见的那一半）
    会一次都不补发，此后没有任何机会。以前这条用例把那个缺口钉成了期望行为。
  */
  test('短中断（2s）结束同样补发一次 stop()；补发不解闸，没收到终态事件就仍然拒绝起录', () => {
    // 冻结墙钟：下面靠「2s 中断」这个确定的间隔表达短中断
    setSystemTime(new Date(Date.now()))
    let session: ReturnType<typeof startVoiceRecording> | null = null
    session = startVoiceRecording(undefined, undefined, () => session?.abort())

    recorderHooks.onInterruptionBegin?.()
    // 来电 2s 就挂断：远短于 5s 宽限期，但已经远超毫秒级的正常收尾窗口
    setSystemTime(new Date(Date.now() + 2_000))
    const stopCallsBefore = recorderStopCalls
    recorderHooks.onInterruptionEnd?.()

    // 短中断也要催一次：账还挂着 = 这一段自己的终态事件确实没到
    expect(recorderStopCalls).toBe(stopCallsBefore + 1)
    expect(() => startVoiceRecording()).toThrow(VoiceRecordingBusyError)

    // 催收不是解闸：补发之后平台仍不投终态事件，再过多久都不许放行
    // （文案升级成可执行的恢复动作，闸门一个字节都没松）
    setSystemTime(new Date(Date.now() + 10 * 60_000))
    let refused: unknown = null
    try {
      startVoiceRecording()
    } catch (error) {
      refused = error
    }
    setSystemTime()
    expect(refused).toBeInstanceOf(VoiceRecordingBusyError)
    expect((refused as Error).message).toContain('重新打开')

    // 真正的终态事件到了才销账（放弃的那一段不交付）
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/late.wav', duration: 20_000 })
    const next = startVoiceRecording()
    const stopped = next.stop()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/next.wav', duration: 1_000 })
    return expect(stopped).resolves.toEqual({ path: 'wxfile://tmp/next.wav', durationMs: 1_000 })
  })

  /*
    #549 增量复审：补发的前提必须是「这道账就是被这次中断打断的那一段」（`session.interrupted`），
    而不是「账上恰好有一个已 stopRequested 的段」。否则一次**迟到**的 `onInterruptionEnd` 会给
    与这次中断无关的后继段再补一次 `stop()`，放大假设 A1「同一段被投两份终态事件」的暴露面。
  */
  test('迟到的 onInterruptionEnd 不给与中断无关的后继段补 stop()', () => {
    // 第一段：被中断 → 页面当场放弃 → 自己的终态事件到达（账销、闸门打开）
    let first: ReturnType<typeof startVoiceRecording> | null = null
    first = startVoiceRecording(undefined, undefined, () => first?.abort())
    recorderHooks.onInterruptionBegin?.()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/interrupted.wav', duration: 3_000 })

    // 第二段：与那次中断无关，用户正常松手（stopRequested=true），正在等自己的收尾
    const second = startVoiceRecording()
    const stopping = second.stop()
    const stopCallsAfterSecond = recorderStopCalls

    // 迟到的中断结束事件：账上只有「第二段」这道账，它从没被中断过
    recorderHooks.onInterruptionEnd?.()
    expect(recorderStopCalls).toBe(stopCallsAfterSecond)
    expect(second.wasInterrupted()).toBe(false)

    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/second.wav', duration: 1_000 })
    return expect(stopping).resolves.toEqual({ path: 'wxfile://tmp/second.wav', durationMs: 1_000 })
  })

  test('中断→abort 之后过了宽限期：为这一段自己的账补发一次 stop()，闸门照旧 fail-closed', () => {
    const events: string[] = []
    let session: ReturnType<typeof startVoiceRecording> | null = null
    session = startVoiceRecording(
      () => events.push('error'),
      () => events.push('auto'),
      () => {
        events.push('interrupted')
        session?.abort()
      },
    )
    recorderHooks.onInterruptionBegin?.()
    expect(events).toEqual(['interrupted'])

    // 已经远超「这一段本该交回收尾事件」的时刻，平台仍没有补发终态事件
    setSystemTime(new Date(Date.now() + 5_001))
    const stopCallsBefore = recorderStopCalls
    recorderHooks.onInterruptionEnd?.()
    setSystemTime()

    // 只对这一段自己的账催一次；闸门一个字节都没松（终态事件还没到）
    expect(recorderStopCalls).toBe(stopCallsBefore + 1)
    expect(() => startVoiceRecording()).toThrow(VoiceRecordingBusyError)
    expect(events).toEqual(['interrupted'])

    // 催回来的终态事件：放弃的段不交付、不通知，但账要销、闸门要开
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/cut.wav', duration: 20_000 })
    expect(events).toEqual(['interrupted'])
    const next = startVoiceRecording()
    const stopped = next.stop()
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/next.wav', duration: 1_000 })
    return expect(stopped).resolves.toEqual({ path: 'wxfile://tmp/next.wav', durationMs: 1_000 })
  })

  test('中断结束后补发的 stop() 抛错：只记日志，闸门仍然 fail-closed（不冒充销账）', () => {
    let session: ReturnType<typeof startVoiceRecording> | null = null
    session = startVoiceRecording(undefined, undefined, () => session?.abort())
    recorderHooks.onInterruptionBegin?.()

    setSystemTime(new Date(Date.now() + 5_001))
    stopThrows = true
    // 抛错不许冒进平台的回调（那里没人接）
    expect(() => {
      recorderHooks.onInterruptionEnd?.()
    }).not.toThrow()
    stopThrows = false
    setSystemTime()

    expect(() => startVoiceRecording()).toThrow(VoiceRecordingBusyError)

    // 残局仍要由终态事件收（下一个用例的 beforeEach 也会兜一次）
    recorderHooks.onStop?.({ tempFilePath: 'wxfile://tmp/cut.wav', duration: 1_000 })
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
