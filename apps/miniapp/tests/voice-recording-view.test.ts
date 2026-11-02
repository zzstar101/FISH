import { describe, expect, test } from 'bun:test'
import {
  isVoiceCancelArmed,
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
