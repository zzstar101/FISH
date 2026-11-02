import { describe, expect, test } from 'bun:test'

/**
 * 「按住说话」录音反馈的**接线契约**（#535）。
 *
 * 本仓 tests 没有 Taro 渲染基建，页面接线只能读源码钉住（先例
 * `conversation-realtime-wiring.test.ts`）。这里钉的是三条最容易漏、且单测抓不到的线：
 * 1. 触摸四件套都绑上，且松手判定读 `cancelArmedRef`（不是 state，避免 setState 延迟）；
 * 2. 录音器「自己停了」（时长上限）有回调，否则面板会继续计时；
 * 3. 所有结束路径（松手/取消/失败/切态/卸载）都过 `resetRecordingUi`。
 */
const PAGE = new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url)
const MEDIA_API = new URL('../src/features/chat/media-api.ts', import.meta.url)

async function read(url: URL): Promise<string> {
  return await Bun.file(url).text()
}

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  if (from === -1) return ''
  const to = text.indexOf(end, from + start.length)
  return to === -1 ? text.slice(from, from + 1200) : text.slice(from, to + end.length)
}

describe('录音反馈接线契约（#535）', () => {
  test('按住说话绑齐 触摸开始/移动/结束/取消，松手走 endVoice', async () => {
    const text = await read(PAGE)
    const hold = between(text, 'className={`conv__hold', '</View>')
    expect(hold).not.toBe('')
    expect(hold).toContain('onTouchStart={startVoice}')
    expect(hold).toContain('onTouchMove={moveVoice}')
    expect(hold).toContain('onTouchEnd={endVoice}')
    expect(hold).toContain('onTouchCancel')
  })

  test('松手判定读 ref（不吃 setState 延迟），且 ref 与 state 同处更新', async () => {
    const text = await read(PAGE)
    expect(text).toContain('const endVoice = () => finishVoice(cancelArmedRef.current)')
    const move = between(text, 'const moveVoice', 'const endVoice')
    expect(move).toContain('cancelArmedRef.current = armed')
    expect(move).toContain('setCancelArmed(armed)')
  })

  test('录音器自停：复位 + 按「取消态 / 被打断 / 录满」三种情形分别处理', async () => {
    const text = await read(PAGE)
    expect(text).toContain('startVoiceRecording(handleVoiceFailure, handleVoiceAutoStop)')
    const auto = between(text, 'const handleVoiceAutoStop', 'sendRecordedVoice(recorded)')
    expect(auto).toContain('setRecording(false)')
    expect(auto).toContain('resetRecordingUi()')
    // 取消态：丢弃；被打断（capped=false）：不发送；录满：发送
    expect(auto).toContain('const cancelled = cancelArmedRef.current')
    expect(auto).toContain('if (cancelled)')
    expect(auto).toContain('if (!capped)')
    expect(text).toContain('sendRecordedVoice(recorded)')
  })

  test('身份快照在起录时拍下（守住「松手 → 拿到音频」窗口换号，复审 medium）', async () => {
    const text = await read(PAGE)
    const start = between(text, 'const startVoice', 'catch (error)')
    expect(start).toContain('voiceIdentityRef.current = currentIdentity()')
    const send = between(text, 'const sendRecordedVoice', 'if (!aliveRef.current)')
    expect(send).toContain('const identity = voiceIdentityRef.current')
    // 发送路径不再自己取当前身份（否则判据恒假）
    expect(send).not.toContain('currentIdentity()')
  })

  test('media-api 暴露 onAutoStop，且只在「没人调 stop()」时触发', async () => {
    const text = await read(MEDIA_API)
    expect(text).toContain('onAutoStop?: (recorded: RecordedVoice, capped: boolean) => void')
    const resolve = between(text, 'resolve: (recorded) =>', 'reject:')
    expect(resolve).toContain('if (!stopping) onAutoStop?.(recorded, ')
    // 「录满」的判定在 media-api 侧给出，页面不该自己猜时长
    expect(resolve).toContain('VOICE_RECORD_MAX_MS - 500')
  })

  test('所有结束路径都过 resetRecordingUi（松手 / 放弃 / 失败 / 卸载）', async () => {
    const text = await read(PAGE)
    const finish = between(text, 'const finishVoice', 'if (cancelled)')
    expect(finish).toContain('resetRecordingUi()')
    const abort = between(text, 'const abortRecording', 'session.abort()')
    expect(abort).toContain('resetRecordingUi()')
    const failure = between(text, 'const handleVoiceFailure', 'const failure = voiceError')
    expect(failure).toContain('resetRecordingUi()')
    // 卸载 cleanup：两个 abort 清理点 + 卸载 effect 都必须清
    const unload = between(text, 'aliveRef.current = false', 'audioRef.current?.destroy()')
    expect(unload).toContain('resetRecordingUi()')
    const abortSites = text.match(
      /recordingRef\.current\?\.abort\(\)\n\s+recordingRef\.current = null\n\s+resetRecordingUi\(\)/g,
    )
    expect((abortSites ?? []).length).toBeGreaterThanOrEqual(2)
  })

  test('录音中挂载反馈面板（计时状态在组件内部，不牵连消息流）', async () => {
    const text = await read(PAGE)
    expect(text).toContain('<VoiceRecordPanel cancelArmed={cancelArmed} />')
    // 页面不再持有秒数计时器（审查 medium：整页每秒重渲染）
    expect(text).not.toContain('setRecordSeconds')
    const panel = await read(
      new URL('../src/pkg-social/pages/conversation/voice-record-panel.tsx', import.meta.url),
    )
    expect(panel).toContain('setInterval(')
    expect(panel).toContain('clearInterval(timer)')
  })
})
