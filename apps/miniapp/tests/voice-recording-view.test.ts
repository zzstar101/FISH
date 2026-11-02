import { describe, expect, test } from 'bun:test'
import {
  applyVoiceAutoStop,
  applyVoiceRelease,
  isVoiceCancelArmed,
  startRecordingTicker,
  VOICE_CANCEL_DISTANCE_PX,
  voiceElapsedSeconds,
  voiceRecordingClock,
} from '../src/pkg-social/pages/conversation/voice-recording-view'

describe('录音期反馈纯逻辑（#535）', () => {
  test('上滑取消：正好到阈值才算武装，未到阈值/下滑都不取消', () => {
    expect(isVoiceCancelArmed(0)).toBe(false)
    expect(isVoiceCancelArmed(-(VOICE_CANCEL_DISTANCE_PX - 1))).toBe(false)
    expect(isVoiceCancelArmed(-VOICE_CANCEL_DISTANCE_PX)).toBe(true)
    expect(isVoiceCancelArmed(-VOICE_CANCEL_DISTANCE_PX * 3)).toBe(true)
    // 下滑（正数）不取消
    expect(isVoiceCancelArmed(120)).toBe(false)
  })

  test('上滑取消：触点坐标丢失时一律不取消（宁可发送，不静默丢弃录音）', () => {
    expect(isVoiceCancelArmed(Number.NaN)).toBe(false)
    expect(isVoiceCancelArmed(Number.POSITIVE_INFINITY)).toBe(false)
  })

  test('已录秒数向下取整，且无效起点/倒退时钟收敛为 0', () => {
    expect(voiceElapsedSeconds(1_000, 1_999)).toBe(0)
    expect(voiceElapsedSeconds(1_000, 2_000)).toBe(1)
    expect(voiceElapsedSeconds(1_000, 65_500)).toBe(64)
    expect(voiceElapsedSeconds(0, 5_000)).toBe(0)
    expect(voiceElapsedSeconds(Number.NaN, 5_000)).toBe(0)
    // 时钟倒退（异常）不显示负数
    expect(voiceElapsedSeconds(9_000, 5_000)).toBe(0)
  })

  test('计时文案 mm:ss，非法值收敛为 00:00', () => {
    expect(voiceRecordingClock(0)).toBe('00:00')
    expect(voiceRecordingClock(5)).toBe('00:05')
    expect(voiceRecordingClock(65)).toBe('01:05')
    expect(voiceRecordingClock(600)).toBe('10:00')
    expect(voiceRecordingClock(-3)).toBe('00:00')
    expect(voiceRecordingClock(Number.NaN)).toBe('00:00')
  })
})

/*
  #535 复审：「录音器自己停了」的处置必须**行为可测**。
  修复前这段判定埋在全页的 `handleVoiceAutoStop` 里，用例只能在源码里搜
  `if (cancelled)` / `if (!capped)` 这样的字符串 —— 把发送调用挪进取消分支照样能过。
  现在判定与副作用收在一个纯函数里：发送只可能发生在「录满且未取消」这一支。
*/
describe('录音自停的处置（#535 复审）', () => {
  function run(cancelled: boolean, capped: boolean) {
    const sent: string[] = []
    const toasts: string[] = []
    applyVoiceAutoStop(
      { cancelled, capped },
      { toast: (title) => toasts.push(title), send: () => sent.push('voice') },
    )
    return { sent, toasts }
  }

  test('用户已滑到「松开 取消」：提示已取消，一对一地不发送', () => {
    const { sent, toasts } = run(true, true)
    expect(sent).toEqual([])
    expect(toasts).toEqual(['录音已取消'])
  })

  test('被打断（capped=false）：不把没说完的半句发出去', () => {
    const { sent, toasts } = run(false, false)
    expect(sent).toEqual([])
    expect(toasts).toEqual(['录音已中断，请重试'])
  })

  test('录满且未取消：提示并发送一次（只有这一支允许发送）', () => {
    const { sent, toasts } = run(false, true)
    expect(sent).toEqual(['voice'])
    expect(toasts).toEqual(['已达最长录音时长，已发送'])
  })

  test('取消优先于录满：取消态即便录满也不发送', () => {
    expect(run(true, false).sent).toEqual([])
  })
})

/*
  #549 收口判据 2：松手时到底能不能把这一段当正常语音发出去，取决于**当前**是不是还处在
  中断态（`onInterruptionBegin` 之后、`onInterruptionEnd` 之前）。「中断发生过」不是状态：
  恢复之后照常发送，否则一次已经恢复的 59s 正常录音会被历史标记吃掉。
*/
describe('松手投递的处置（#549）', () => {
  function run(interrupted: boolean) {
    const sent: string[] = []
    const toasts: string[] = []
    applyVoiceRelease(
      { interrupted },
      { toast: (title) => toasts.push(title), send: () => sent.push('voice') },
    )
    return { sent, toasts }
  }

  test('中断已结束（当前不在中断态）：照常发送', () => {
    const { sent, toasts } = run(false)
    expect(sent).toEqual(['voice'])
    expect(toasts).toEqual([])
  })

  test('当前仍处于中断态：不发这段被截断的音频，并明确告诉用户重录', () => {
    const { sent, toasts } = run(true)
    expect(sent).toEqual([])
    expect(toasts).toEqual(['录音已被来电打断，请稍后再按住重录'])
  })
})

/*
  #535 复审：「计时器在跑」不等于「显示的秒数在走」。
  修复前面板测试只搜 `setInterval(` / `clearInterval(timer)` 两个字符串，把节拍回调
  换成空函数照样能过，而面板会一直停在 00:00。节拍抽成可注入时钟的纯逻辑后，
  直接驱动节拍断言「每次节拍都用当前时刻重算秒数」。
*/
describe('录音计时节拍（#535 复审）', () => {
  test('每次节拍都用当前时刻重算秒数；停表之后迟到的节拍不再上报', () => {
    const seen: number[] = []
    let clock = 10_000
    let tick: (() => void) | null = null
    let cleared = 0

    const stop = startRecordingTicker((seconds) => seen.push(seconds), {
      now: () => clock,
      schedule: (fn) => {
        tick = fn
        return 'timer-1'
      },
      cancel: (handle) => {
        expect(handle).toBe('timer-1')
        cleared += 1
      },
    })

    clock = 12_400
    tick?.()
    clock = 61_000
    tick?.()
    expect(seen).toEqual([2, 51])

    stop()
    expect(cleared).toBe(1)
    tick?.()
    expect(seen).toEqual([2, 51])
  })

  test('起点非法（时钟异常）时秒数收敛为 0，不显示负数', () => {
    const seen: number[] = []
    let tick: (() => void) | null = null
    startRecordingTicker((seconds) => seen.push(seconds), {
      now: () => Number.NaN,
      schedule: (fn) => {
        tick = fn
        return 0
      },
      cancel: () => undefined,
    })
    tick?.()
    expect(seen).toEqual([0])
  })
})
