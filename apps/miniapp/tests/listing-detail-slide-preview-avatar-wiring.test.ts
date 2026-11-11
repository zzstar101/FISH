import { describe, expect, test } from 'bun:test'

/**
 * #677 商品详情页三处接线的回归。
 *
 * 端上行为（点图进预览、长按出微信图片菜单、头像显示当前账号、收藏弹提示）只能在微信开发者
 * 工具里验，这里钉住结构：预览层是自绘半透明遮罩 + `showMenuByLongpress`、留言输入条头像不再
 * 写死「我」、收藏成功后有字面反馈。
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

/** 取一条 SCSS 规则块（从选择器到配对的 `}`）。 */
function ruleBlock(scss: string, selector: string): string {
  const from = scss.indexOf(selector)
  expect(from, `样式里应出现 ${selector}`).toBeGreaterThanOrEqual(0)
  const to = scss.indexOf('}', from)
  expect(to, `${selector} 应有闭合的 }`).toBeGreaterThanOrEqual(0)
  return scss.slice(from, to + 1)
}

describe('详情页大图预览用页内半透明遮罩（#677）', () => {
  test('openPreview 收下标、无图不弹；closePreview 复位成 null', async () => {
    const code = stripComments(await source('pkg-browse/pages/listing-detail/index.tsx'))
    const open = sliceFrom(code, 'const openPreview = (index: number) =>', '\n  }')
    expect(open).toContain('if (images.length === 0) return')
    expect(open).toContain('setPreviewIndex(index)')

    const close = sliceFrom(code, 'const closePreview = () =>', '\n  }')
    expect(close).toContain('setPreviewIndex(null)')

    // 不开预览时是 null，不是 0 —— 0 会被当成「开在第二张图」渲染出遮罩
    expect(code).toContain('useState<number | null>(null)')
  })

  test('轮播图每张都绑了 onClick → openPreview(自己那张的下标)', async () => {
    const code = stripComments(await source('pkg-browse/pages/listing-detail/index.tsx'))
    const slides = sliceFrom(code, '{images.map((url, index) => (', '))}')
    expect(slides).toContain('className="detail__slide-img"')
    expect(slides).toContain('onClick={() => openPreview(index)}')
  })

  test('遮罩层带 catchMove、点任意处关闭；图片用 aspectFit + showMenuByLongpress', async () => {
    const code = stripComments(await source('pkg-browse/pages/listing-detail/index.tsx'))
    const viewer = sliceFrom(code, 'className="detail__viewer"', 'className="detail__viewer-count"')

    // catchMove（= catchtouchmove）否则手势会穿透到下面的页面滚动
    expect(viewer).toContain('catchMove')
    expect(viewer).toContain('onClick={closePreview}')
    // 长按菜单交给微信客户端：与原生预览同一套转发/保存/收藏/翻译/提取文字
    expect(viewer).toContain('showMenuByLongpress')
    // 完整显示整张图（轮播卡片是 aspectFill 裁切）
    expect(viewer).toContain('mode="aspectFit"')
    // 只有一张图时不给 circular，免得原地打转
    expect(viewer).toContain('circular={images.length > 1}')
    // 不再用原生预览：底色纯黑且不可改
    expect(code).not.toContain('Taro.previewImage')
  })

  test('遮罩底色是半透明 rgba，不是纯黑', async () => {
    const scss = stripComments(await source('pkg-browse/pages/listing-detail/index.scss'))
    const block = ruleBlock(scss, '.detail__viewer {')
    expect(block).toContain('background: rgba(0, 0, 0, 0.6)')
    // 压过底栏（100）与弹层（110/120）
    expect(block).toContain('z-index: 200')
  })
})

describe('详情页收藏后有字面提示（#677）', () => {
  test('写接口成功后按结果弹「已收藏 / 已取消收藏」', async () => {
    const code = stripComments(await source('pkg-browse/pages/listing-detail/index.tsx'))
    const write = sliceFrom(code, 'void setFavorite(id, !faved)', '.catch(')
    expect(write).toContain('setFaved(state.favorited)')
    expect(write).toContain("state.favorited ? '已收藏' : '已取消收藏'")
    expect(write).toContain('Taro.showToast')
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
