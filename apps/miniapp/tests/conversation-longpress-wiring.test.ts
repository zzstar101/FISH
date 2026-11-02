import { describe, expect, test } from 'bun:test'

/**
 * #518 长按菜单的接线层回归。
 *
 * 仓库没有 Taro 组件渲染基建，长按/点击的真实事件顺序只能在微信开发者工具里验；
 * 这里钉住三条最容易回退的结构：长按统一置吞 tap 标志、三类气泡都接了长按、语音气泡的
 * 点击首行先消费标志。
 */

async function source(relative: string): Promise<string> {
  return Bun.file(new URL(`../src/${relative}`, import.meta.url)).text()
}

function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

describe('会话页长按气泡的接线（#518）', () => {
  test('onLongPressMessage 统一置位，图片/语音/商品卡共用同一条路径', async () => {
    const code = await source('pkg-social/pages/conversation/index.tsx')
    const onLongPress = sliceFrom(code, 'const onLongPressMessage = async', 'const doRecall = ')

    // 少这一行，长按语音后补发的 tap 会触发播放（图片/商品卡同理）
    expect(onLongPress).toContain('beginBubbleLongPress()')
    expect(onLongPress.indexOf('beginBubbleLongPress()')).toBeLessThan(
      onLongPress.indexOf('const actions'),
    )
    // 图片分支直接绑在气泡上；语音分支把回调作为第 6 个参数传给 renderVoiceBubble
    expect(
      code.match(/onLongPress=\{\(\) => void onLongPressMessage\(item\)\}/g) ?? [],
    ).toHaveLength(1)
    expect(code).toContain('() => void onLongPressMessage(item),')
    expect(code).toContain('onLongPress={() => void onLongPressMessage(message)}')
  })

  test('语音气泡点击先 consume 再播放，长按不会顺手放音', async () => {
    const code = await source('pkg-social/pages/conversation/index.tsx')
    const voice = sliceFrom(code, 'const renderVoiceBubble = (', 'const abortRecording = () =>')

    expect(voice).toContain('onTouchStart={resetBubbleTapGuard}')
    expect(voice).toContain('onLongPress={onLongPress}')
    expect(voice).toContain('if (consumeBubbleTap()) return')
  })
})
