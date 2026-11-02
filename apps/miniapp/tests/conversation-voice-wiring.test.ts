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

  test('toggleVoiceMode 在进入语音态前走严格隐私授权，并有在途代次守卫', async () => {
    const block = sliceFrom(
      await source(),
      'const toggleVoiceMode = async () => {',
      'const onLongPressMessage',
    )
    expect(block).toContain('ensurePrivacyAuthorizedStrict()')
    expect(block).toContain('voiceGateSeqRef.current')
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
