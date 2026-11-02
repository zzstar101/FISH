import { describe, expect, test } from 'bun:test'

/**
 * #518 长按菜单的接线层回归。
 *
 * 仓库没有 Taro 组件渲染基建，长按/点击的真实事件顺序只能在微信开发者工具里验；
 * 这里钉住四条最容易回退的结构：长按统一置吞 tap 标志、三类气泡都接了长按、语音气泡的
 * 点击首行先消费标志、`doRecall` 成功后本地同步落媒体流。
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

/** 剥掉注释再断言：注释里写一遍同名语句不能冒充接线（仓库既有写法，见 back-top-scroll-source.test.ts）。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
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
    // 待发语音没有菜单可开，但也必须用 no-op 长按置位，否则长按后的 tap 会播放本地录音
    expect(voice).toContain('onLongPress={onLongPress ?? beginBubbleLongPress}')
    expect(voice).toContain('if (consumeBubbleTap()) return')
  })

  test('媒体气泡显示引用、引用媒体可定位、多选图片只让第一张带引用', async () => {
    const code = await source('pkg-social/pages/conversation/index.tsx')
    const media = sliceFrom(
      code,
      "if (entry.kind === 'media')",
      "if (entry.kind === 'pending-media')",
    )
    const pendingMedia = sliceFrom(
      code,
      "if (entry.kind === 'pending-media')",
      'const message = entry.message',
    )
    const locate = sliceFrom(code, 'const locateMessage = (', 'const renderMediaQuote = (')
    const picker = sliceFrom(code, 'const pickAndSendImages = async', 'const handleVoiceFailure = ')

    // 服务端与本地乐观媒体都要画出摘引；本地条目没有服务端 id，不接定位点击
    // 引用条在气泡外，固定用 floating 配色（不能用气泡内的 is-mine 白字）
    expect(media).toContain('renderMediaQuote(item.replyTo, true)')
    expect(pendingMedia).toContain('renderMediaQuote(item.replyTo, false)')
    // 引用媒体消息时，定位判据必须同时查 media 流
    expect(locate).toContain('media.some((item) => item.id === messageId)')
    // 多选图片：同步循环里只有第一张拿引用，其余显式 null
    expect(picker).toContain('const replyForBatch = replyTarget')
    expect(picker).toContain('index === 0 ? replyForBatch : null')
  })
})

/**
 * #518 验收「媒体自撤回本地立即翻碑，不依赖实时推送」的接线回归。
 *
 * 同一个文件里 `applyMediaRecalled` 还有一处调用在 `message.recalled` 实时分支上，
 * 但推送是「尽力而为」：撤回自己的图片/语音后能立刻翻碑，靠的是 `doRecall` 自己落流。
 * 因此断言只认 `doRecall` 函数体、并且剥掉注释 —— 推送分支与注释都不能顶替这处接线。
 */
describe('doRecall 成功后本地落媒体流（#518 媒体自撤回）', () => {
  test('撤回后由 doRecall 自己改 media 流，而不是等 message.recalled 推送', async () => {
    const code = await source('pkg-social/pages/conversation/index.tsx')
    const recall = stripComments(
      sliceFrom(code, 'const doRecall = async', 'const locateMessage = ('),
    )

    // 删掉这一处 setMedia，撤回自己的图片/语音后气泡纹丝不动（要等推送或重进页面）
    expect(recall).toContain('setMedia((prev) =>')
    // 命中的必须是本次撤回的那条（实时分支用的是 event.messageId / event.recalledAt）
    expect(recall).toContain('applyMediaRecalled(prev, message.id, recalledAt)')
  })
})
