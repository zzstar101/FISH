import { describe, expect, test } from 'bun:test'

/**
 * #677 商品详情页两处接线的回归。
 *
 * 端上行为（点图进原生预览、长按出微信图片菜单、头像显示当前账号）只能在微信开发者工具里验，
 * 这里钉住结构：轮播图真的绑了 `previewImage`（且传整组图片）、留言输入条头像不再写死「我」。
 */

async function source(relative: string): Promise<string> {
  return Bun.file(new URL(`../src/${relative}`, import.meta.url)).text()
}

/** 剥掉注释再断言：注释里写一遍同名语句不能冒充接线（仓库既有写法）。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

describe('商品详情页轮播图进原生大图预览（#677）', () => {
  test('previewSlide 传整组商品图并指定当前这张', async () => {
    const code = stripComments(await source('pkg-browse/pages/listing-detail/index.tsx'))
    const fn = sliceFrom(code, 'const previewSlide = (current: string) =>', '\n  }')

    // 长按菜单（转发 / 保存 / 收藏 / 翻译 / 提取文字）只有微信原生预览态才有，自己拼 urls 单张会丢掉翻页
    expect(fn).toContain('Taro.previewImage({ urls: images, current })')
    // 详情还没到时不弹空白预览
    expect(fn).toContain('if (images.length === 0) return')
  })

  test('轮播图每张都绑了 onClick → previewSlide(自己那张)', async () => {
    const code = stripComments(await source('pkg-browse/pages/listing-detail/index.tsx'))
    const slides = sliceFrom(code, '{images.map((url) => (', '))}')
    expect(slides).toContain('className="detail__slide-img"')
    expect(slides).toContain('onClick={() => previewSlide(url)}')
  })
})

describe('留言输入条头像用当前账号头像（#677）', () => {
  test('不再写死「我」的占位圆点', async () => {
    const code = stripComments(await source('pkg-browse/pages/listing-detail/index.tsx'))
    expect(code).not.toContain('detail__cmt-me-text')
    const bar = sliceFrom(code, 'className="detail__cmt-bar"', 'className="detail__cmt-in"')
    expect(bar).not.toContain('>我<')
  })

  test('改用统一 UserAvatar + 当前登录用户的 avatarUrl', async () => {
    const code = stripComments(await source('pkg-browse/pages/listing-detail/index.tsx'))
    const bar = sliceFrom(code, 'className="detail__cmt-bar"', 'className="detail__cmt-in"')
    expect(bar).toContain('UserAvatar')
    expect(bar).toContain('className="detail__cmt-me"')
    // 无头像 / 未登录由 UserAvatar 回落默认头像插画，这里不能自己再兜一张写死的图
    expect(bar).toContain('src={user?.avatarUrl ?? null}')
  })
})
