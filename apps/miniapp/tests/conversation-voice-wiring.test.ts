/**
 * 会话页语音链路的接线回归（#516/#526）。
 *
 * 仓库没有 Taro 组件渲染基建，页面事件顺序只能读源码钉住；判据层由
 * `tests/privacy.test.ts` 与 `tests/chat-media-api.test.ts` 覆盖。
 *
 * 这里锁住两件容易在后续重构中悄悄退化的事：
 * 1. `startVoice` 必须保持同步（隐私 gate 在 `toggleVoiceMode`，不能 await 在触摸序列里）；
 * 2. 录音阶段才报 privacy 时，必须退回键盘态并给「去授权」入口。
 */
import { describe, expect, test } from 'bun:test'

async function source(): Promise<string> {
  return Bun.file(new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url)).text()
}

function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

describe('#516 会话页语音 · 接线', () => {
  test('startVoice 保持同步，隐私 gate 不在触摸序列里 await', async () => {
    const block = sliceFrom(await source(), 'const startVoice = () => {', 'const finishVoice')
    expect(block).not.toContain('async')
    expect(block).not.toContain('await')
  })

  test('toggleVoiceMode 在进入语音态前走三态授权，并用纯判据挡旧代次/离页', async () => {
    const block = sliceFrom(
      await source(),
      'const toggleVoiceMode = async () => {',
      'const onLongPressMessage',
    )
    expect(block).toContain('getPrivacyAuthorizationState()')
    expect(block).toContain(
      'canEnterVoiceMode(state, seq, voiceGateSeqRef.current, aliveRef.current)',
    )
    // 拒绝/未知的 return 必须在 setVoiceMode(true) 之前：未授权绝不能进入语音态。
    expect(block.indexOf('if (!canEnterVoiceMode')).toBeGreaterThanOrEqual(0)
    expect(block.indexOf('if (!canEnterVoiceMode')).toBeLessThan(
      block.indexOf('setVoiceMode(true)'),
    )
    // 查询失败与用户拒绝要给不同文案。
    expect(block).toContain("state === 'denied'")
    expect(block).toContain('无法确认隐私授权状态')
  })

  test('账号切换会作废在途的语音授权', async () => {
    const block = sliceFrom(await source(), 'if (prevUserId !== userId) {', '/*')
    expect(block).toContain('voiceGateSeqRef.current += 1')
  })

  test('录音阶段 privacy 失败会退回键盘态并给去授权入口', async () => {
    const block = sliceFrom(await source(), 'const handleVoiceFailure =', 'const startVoice')
    expect(block).toContain('instanceof VoicePrivacyError')
    expect(block).toContain('setVoiceMode(false)')
    expect(block).toContain('requestPrivacyAuthorize()')
    // privacy 分支必须在麦克风权限分支之前，否则 privacy errMsg 又会走 openSetting。
    expect(block.indexOf('VoicePrivacyError')).toBeLessThan(block.indexOf('VoicePermissionError'))
  })
})
