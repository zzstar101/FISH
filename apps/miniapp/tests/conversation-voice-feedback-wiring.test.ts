import { describe, expect, test } from 'bun:test'

/**
 * 「按住说话」录音反馈的**接线契约**（#535）。
 *
 * 本仓 tests 没有 Taro 渲染基建，页面接线只能读源码钉住（先例
 * `conversation-realtime-wiring.test.ts`）。这里只钉**页面自己**那层接线，且每条都钉到
 * 实参/调用形状上（否则把取消改成发送、把发送挪进取消分支都照样能过）：
 * 1. 触摸四件套都绑上，`onTouchCancel` 必须落在取实参 `true` 的取消支上；
 * 2. 录音器「自己停了」的取舍交给 `applyVoiceAutoStop`（行为在纯逻辑用例里）；
 * 3. 所有结束路径（松手/取消/失败/切态/卸载）都过 `resetRecordingUi`。
 * 录音器本身的行为（迟到结果归属、录满 vs 被打断）在 `chat-media-api.test.ts` 里真跑。
 */
const PAGE = new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url)

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
    /*
      触摸取消必须绑到**取消**分支上（#535 复审 medium）。
      只断言 `onTouchCancel` 这个名字出现过是不够的：把处理函数改成走发送路径
      （`finishVoice(false)`）照样能过，而平台一旦派发 touchcancel，用户想丢弃的
      这一段就会被发出去。这里钉住实参，把取消/发送的语义分不开就不许过。
    */
    expect(hold).toMatch(/onTouchCancel=\{\(\) => finishVoice\(true\)\}/)
    expect(hold).not.toMatch(/onTouchCancel=\{\(\) => finishVoice\(false\)\}/)
  })

  test('松手判定读 ref（不吃 setState 延迟），且 ref 与 state 同处更新', async () => {
    const text = await read(PAGE)
    expect(text).toContain('const endVoice = () => finishVoice(cancelArmedRef.current)')
    const move = between(text, 'const moveVoice', 'const endVoice')
    expect(move).toContain('cancelArmedRef.current = armed')
    expect(move).toContain('setCancelArmed(armed)')
  })

  test('录音器自停：复位后把「取消 / 被打断 / 录满」的取舍交给被测过的判定（#535 复审）', async () => {
    const text = await read(PAGE)
    expect(text).toContain('startVoiceRecording(')
    expect(text).toContain('handleVoiceFailure,')
    expect(text).toContain('handleVoiceAutoStop,')
    // 中断（来电 / 视频通话）也必须接上：不接的话这一段音频会被当成正常语音发出去（#549）
    expect(text).toContain('handleVoiceInterrupted,')
    const auto = between(text, 'const handleVoiceAutoStop', '\n  }')
    expect(auto).toContain('setRecording(false)')
    expect(auto).toContain('resetRecordingUi()')
    /*
      「取消态 / 被打断 / 录满」三种取舍不得只靠源码里搜 `if (cancelled)` 这类字符串：
      把发送挪进取消分支、或者调换这两个判据的顺序，字符串还在、发送却错了。
      取舍收进 `applyVoiceAutoStop`（行为用例见 voice-recording-view.test.ts），
      页面这里只允许把发送作为它的 `send` 回调出现一次。
    */
    expect(auto).toContain('applyVoiceAutoStop(')
    expect(auto).toContain('const cancelled = cancelArmedRef.current')
    expect(auto.match(/sendRecordedVoice\(recorded, identity\)/g) ?? []).toHaveLength(1)
    expect(auto).not.toMatch(/if \(cancelled\)/)
    expect(auto).not.toMatch(/if \(!capped\)/)
  })

  test('松手投递前先看「此刻是否仍在中断态」（#549 收口判据 2）', async () => {
    const text = await read(PAGE)
    const finish = between(text, 'const finishVoice', 'resetUi: recordingRef.current === null })')
    /*
      中断态（来电 / 视频通话把录音暂停了）下这一段音频是截断的，不能当正常语音发出去；
      但「中断发生过」不算数 —— 中断结束之后照常发送。取舍在 `applyVoiceRelease`
      （行为用例见 voice-recording-view.test.ts），页面这里只允许把发送作为它的 `send`
      回调出现一次，不许在它之外直接发。
    */
    expect(finish).toContain('session.wasInterrupted()')
    expect(finish).toContain('applyVoiceRelease(')
    expect(finish.match(/sendRecordedVoice\(recorded, identity\)/g) ?? []).toHaveLength(1)
    expect(finish).not.toMatch(/if \(interrupted\)/)
  })

  test('来电中断当场放弃这一段：复位面板 + 明确提示重录（#549 / 需求 4 失效路径）', async () => {
    const text = await read(PAGE)
    const interrupted = between(text, 'const handleVoiceInterrupted', '\n  }')
    expect(interrupted).toContain('resetRecordingUi()')
    expect(interrupted).toContain('setRecording(false)')
    expect(interrupted).toContain('session.abort()')
    expect(interrupted).toContain('录音已被来电打断，请稍后再按住重录')
  })

  test('身份按「这一段」传下去（起录时拍下，发送不再读页面级 ref）', async () => {
    const text = await read(PAGE)
    const start = between(text, 'const startVoice', 'catch (error)')
    expect(start).toContain('voiceIdentityRef.current = currentIdentity()')
    /*
      发送是异步的（`stop()` 回来才走到），背靠背两段录音时页面级 ref 可能已经被下一段
      覆盖：那样第一段会拿第二段的身份去过 `isStaleMediaIdentity`（#535 follow-up F3）。
      所以 identity 必须是参数，两个同步点各自传自己那一刻的快照。
    */
    const send = between(text, 'const sendRecordedVoice', 'if (!aliveRef.current)')
    expect(send).toContain('identity: MediaTaskIdentity')
    expect(send).not.toContain('voiceIdentityRef.current')
    // 发送路径不再自己取当前身份（否则判据恒假）
    expect(send).not.toContain('currentIdentity()')

    for (const site of ['const handleVoiceAutoStop', 'const finishVoice']) {
      const body = between(text, site, '\n  }')
      expect(body).toContain('const identity = voiceIdentityRef.current')
      expect(body).toContain('sendRecordedVoice(recorded, identity)')
    }
  })

  test('上一段的失败晚到不许复位正在录的那一段（#535 follow-up F1）', async () => {
    const text = await read(PAGE)
    /*
      松手后 `stop()` 的失败是异步回来的，那时用户可能已经又按下第二段：`recordingRef`
      已经不是失败的那一段。复位就等于把还在录的那一段打死（面板消失、按钮回到「按住
      说话」，麦克风却还在录）。
    */
    const finish = between(text, 'const finishVoice', 'resetUi: recordingRef.current === null })')
    expect(finish).toContain(
      'handleVoiceFailure(error, { resetUi: recordingRef.current === null })',
    )
    const failure = between(text, 'const handleVoiceFailure', 'const failure = voiceError')
    expect(failure).toContain('options.resetUi ?? true')
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
    /*
      面板只负责把节拍结果塞进 state（#535 复审 medium）。
      只断言面板里有 `setInterval(` 抓不到「计时器在跑、秒数却不再更新」：
      面板现在调用被测过的 `startRecordingTicker`，节拍逻辑（每次重算秒数 /
      停表后不再上报）在 voice-recording-view.test.ts 里行为验证。
    */
    const panel = await read(
      new URL('../src/pkg-social/pages/conversation/voice-record-panel.tsx', import.meta.url),
    )
    expect(panel).toContain('startRecordingTicker(setSeconds)')
    expect(panel).not.toContain('setInterval(')
  })
})
