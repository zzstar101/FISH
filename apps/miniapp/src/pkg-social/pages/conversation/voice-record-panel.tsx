import { Text, View } from '@tarojs/components'
import { useEffect, useRef, useState } from 'react'
import { voiceElapsedSeconds, voiceRecordingClock } from './voice-recording-view'
import './voice-record-panel.scss'

/** 波形条数量：5 条，靠 animationDelay 错位形成流动感 */
const WAVE_BARS = [0, 1, 2, 3, 4] as const

/**
 * 「按住说话」录音期反馈面板（#535）。
 *
 * 独立组件的原因（审查 medium）：计时状态若放在会话页，每秒都会让整页（含全部消息气泡）
 * 重渲染一遍。计时器与秒数收在这里，页面只传「是否已滑到取消区」，消息流不再被牵连。
 *
 * 生命周期 = 录音生命周期：只在录音中被挂载，卸载时清计时器；起点时刻取挂载时间，
 * 秒数由 `Date.now()` 与起点算出（不累加，避免长时间录音漂移）。
 */
export default function VoiceRecordPanel({ cancelArmed }: { cancelArmed: boolean }) {
  const [seconds, setSeconds] = useState(0)
  const startedAtRef = useRef(Date.now())

  useEffect(() => {
    startedAtRef.current = Date.now()
    const timer = setInterval(() => {
      setSeconds(voiceElapsedSeconds(startedAtRef.current, Date.now()))
    }, 250)
    return () => clearInterval(timer)
  }, [])

  return (
    <View className={`vrec${cancelArmed ? ' is-cancel' : ''}`}>
      <View className="vrec__wave">
        {WAVE_BARS.map((bar) => (
          <View key={bar} className="vrec__bar" style={{ animationDelay: `${bar * 110}ms` }} />
        ))}
      </View>
      <Text className="vrec__time num">{voiceRecordingClock(seconds)}</Text>
      <Text className="vrec__hint">{cancelArmed ? '松开 取消' : '上滑取消'}</Text>
    </View>
  )
}
