import { describe, expect, test } from 'bun:test'

/**
 * #517「头像 / 昵称 → 他人主页」的接线层回归。
 *
 * 仓库没有 Taro 组件渲染基建（`tests/comments-wiring.test.ts` 头注：既无
 * `@testing-library/*` 也无 `react-test-renderer`），事件绑定本身只能在微信开发者工具里
 * 逐页演示；这里用源码片段钉住「入口存在、目标只有一个、缺 id 不猜人」这几条最容易
 * 回退的结构。
 */

async function source(relative: string): Promise<string> {
  return Bun.file(new URL(`../src/${relative}`, import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

describe('会话页：头像 / 顶部昵称 → 主页（#517）', () => {
  test('对方头像与顶部昵称走同一个 openCounterpart，目标带 counterpart.id', async () => {
    const code = await source('pkg-social/pages/conversation/index.tsx')

    const openCounterpart = sliceFrom(
      code,
      'const openCounterpart = () => {',
      'const openSelfProfile = () => {',
    )
    expect(openCounterpart).toContain('/pkg-browse/pages/user/index?id=')
    expect(openCounterpart).toContain('encodeURIComponent(conversation.counterpart.id)')
    expect(code).toContain('onClick={mine ? openSelfProfile : openCounterpart}')
    expect(code).toContain('<Text className="conv__title-nm" onClick={openCounterpart}>')
  })

  test('自己的头像进编辑资料页，不跳公开主页', async () => {
    const code = await source('pkg-social/pages/conversation/index.tsx')
    const openSelf = sliceFrom(
      code,
      'const openSelfProfile = () => {',
      // #531 起 `openMeetup` 接收交易 id，签名变了但「声明在 openSelfProfile 之后」的
      // 结构不变：这里只钉 openSelfProfile 的函数体边界，不钉邻居的签名。
      'const openMeetup = (transactionId: string) => {',
    )
    expect(openSelf).toContain("url: '/pkg-auth/pages/profile-edit/index'")
    expect(openSelf).not.toContain('/pkg-browse/pages/user/index')
  })

  test('标题定位层 pointer-events:none，昵称必须单独恢复点击', async () => {
    const scss = await Bun.file(
      new URL('../src/pkg-social/pages/conversation/index.scss', import.meta.url),
    ).text()
    const title = sliceFrom(scss, '.conv__title {', '}')
    expect(title).toContain('pointer-events: none')
    const nickname = sliceFrom(scss, '.conv__title-nm {', '}')
    expect(nickname).toContain('pointer-events: auto')
  })
})

describe('商品详情：卖家区一个入口，留言作者可进主页（#517）', () => {
  test('点区上提到 .detail__seller，detail__go 只剩视觉提示（同一次点击只跳一次）', async () => {
    const code = await source('pkg-browse/pages/listing-detail/index.tsx')
    expect(code).toContain('<View className="detail__seller" onClick={openSellerHome}>')

    const go = sliceFrom(code, '<View className="detail__go">', '<Text>进TA主页</Text>')
    expect(go).not.toContain('onClick')

    const openSeller = sliceFrom(
      code,
      'const openSellerHome = () => {',
      'const openCommentAuthor =',
    )
    expect(openSeller).toContain('/pkg-browse/pages/user/index?id=')
    expect(openSeller).toContain('encodeURIComponent(data.seller.id)')
  })

  test('留言节点保留 author.id / avatarUrl，缺图渲统一默认头像（不再退首字）', async () => {
    const code = await source('pkg-browse/pages/listing-detail/index.tsx')
    const node = sliceFrom(code, 'type CommentNode = {', 'let localSeq')
    expect(node).toContain('authorId: string | null')
    expect(node).toContain('authorAvatarUrl: string | null')

    expect(code).toContain('authorId: comment.author.id')
    expect(code).toContain('authorAvatarUrl: comment.author.avatarUrl')
    // 本地乐观占位与演示 mock 都不编作者身份
    expect(code.match(/authorId: null/g) ?? []).toHaveLength(2)

    // 顶层与回复共用 CommentAvatar：一律走统一的 UserAvatar —— 有图渲真图，
    // 无图 / 图挂了（断网、CDN 404）都渲同一张默认头像（#618 起不再退昵称首字）
    expect(code.match(/<CommentAvatar/g) ?? []).toHaveLength(2)
    expect(code).toContain('src={node.authorAvatarUrl}')
    expect(code).not.toContain('detail__cav-text')
    expect(code).not.toContain('detail__cav-img')
  })

  test('缺 authorId 给提示、不猜人；有 id 才跳主页', async () => {
    const code = await source('pkg-browse/pages/listing-detail/index.tsx')
    const open = sliceFrom(code, 'const openCommentAuthor =', 'return (')
    expect(open).toContain("title: '这位用户的主页暂不可打开'")
    expect(open).toContain('/pkg-browse/pages/user/index?id=')
    expect(open).toContain('encodeURIComponent(target.authorId)')
    expect(open.indexOf('if (!target.authorId)')).toBeLessThan(open.indexOf('Taro.navigateTo'))
  })
})

describe('「我的」页：主页钮进自己的公开主页（#578）', () => {
  test('头部动作区新增主页钮，点击带当前登录用户 id 进公开主页', async () => {
    const code = await source('pages/profile/index.tsx')
    const open = sliceFrom(code, 'const openMyProfile = () => {', 'const onLogout =')
    expect(open).toContain('/pkg-browse/pages/user/index?id=')
    expect(open).toContain('encodeURIComponent(uid)')
    // 缺 id 先返回，不拼半截 url 去猜人。先断言守卫**存在**再比先后 —— 守卫被删掉时
    // `indexOf` 给 -1，`-1 < 正数` 照样成立，只比顺序是假绿（上面 `:107` 是既有写法，
    // 不照抄）。
    expect(open).toContain('if (!uid) return')
    expect(open.indexOf('if (!uid) return')).toBeLessThan(open.indexOf('Taro.navigateTo'))
    expect(code).toContain('<View className="profile__homebtn" onClick={openMyProfile}>')
    // 未登录不该看见：钮在 `if (anonymous)` 早返回之后，匿名分支根本走不到这里
    expect(code.indexOf('if (anonymous)')).toBeGreaterThan(-1)
    expect(code.indexOf('if (anonymous)')).toBeLessThan(code.indexOf('profile__homebtn'))
  })

  test('头像 / 昵称 / 右箭头仍是编辑资料（#86 B），主页钮不顶替它们', async () => {
    const code = await source('pages/profile/index.tsx')
    expect(code).toContain(
      "const openEditProfile = () => void Taro.navigateTo({ url: '/pkg-auth/pages/profile-edit/index' })",
    )
    expect(code).toContain(
      '<UserAvatar className="profile__avatar" src={user.avatarUrl} onClick={openEditProfile} />',
    )
    expect(code).toContain('<Text className="profile__name" onClick={openEditProfile}>')
  })
})

describe('他人主页页头：本人态的说明与出口（#578）', () => {
  test('回「我的」走 switchTab（Tab 页，navigateTo 到不了）', async () => {
    const code = await source('pkg-browse/pages/user/index.tsx')
    const goMy = sliceFrom(code, 'const goMyProfile = () =>', 'const navReportAction')
    expect(goMy).toContain("Taro.switchTab({ url: '/pages/profile/index' })")
    expect(goMy).not.toContain('Taro.navigateTo')
  })

  test('提示只在 isSelf 渲染，整行可点回「我的」', async () => {
    const code = await source('pkg-browse/pages/user/index.tsx')
    expect(code).toContain('{isSelf ? (')
    const note = sliceFrom(code, 'className="uhome__selfnote"', 'uhome__selfnote-exit-ic')
    expect(note).toContain('这是你的公开主页')
    expect(note).toContain('onClick={goMyProfile}')
    expect(note).toContain('回我的')
    // 反向断言：提示块必须**在** `{isSelf ? (` 这个三元里面，且三元在它之前没闭合 ——
    // 否则他人主页（isSelf 为假）也会看到「这是你的公开主页」。
    const selfIdx = code.indexOf('{isSelf ? (')
    const noteIdx = code.indexOf('className="uhome__selfnote"')
    expect(noteIdx).toBeGreaterThan(selfIdx)
    expect(code.slice(selfIdx, noteIdx)).not.toContain(') : null}')
  })

  test('关注钮 / 举报钮的本人态判据原样不动（只加提示，不改既有语义）', async () => {
    const code = await source('pkg-browse/pages/user/index.tsx')
    expect(code).toContain("const canFollow = authedUser !== null && !isSelf && userId !== ''")
    expect(code).toContain('profile && !isSelf ? (')
  })
})

describe('我的收藏：卖家头像 → 主页，且不连带开详情（#517）', () => {
  test('适配器把 listing.seller.id 带到 sellerId；缺席留 null', async () => {
    const code = await source('pkg-browse/pages/favorites/list.ts')
    expect(code).toContain('sellerId: string | null')
    expect(code).toContain('sellerId: listing.seller?.id ?? null')
    expect(code).toContain('sellerId: null')
  })

  test('openSeller：演示行 / 缺 id 只 toast，真实行带 sellerId 跳主页', async () => {
    const code = await source('pkg-browse/pages/favorites/index.tsx')
    expect(code).toContain("toast('演示数据：卖家主页不可打开')")
    expect(code).toContain("toast('这位卖家的主页暂不可打开')")
    expect(code).toContain('/pkg-browse/pages/user/index?id=')
    expect(code).toContain('encodeURIComponent(item.sellerId)')
    const open = sliceFrom(code, 'const openSeller = (item: FavoriteItem) => {', 'const onRowTap')
    expect(open.indexOf('if (item.demo)')).toBeLessThan(open.indexOf('item.sellerId'))
  })

  test('fav__seller 拦冒泡并走 act（管理态与其他动作钮一致）', async () => {
    const code = await source('pkg-browse/pages/favorites/index.tsx')
    const seller = sliceFrom(code, 'className="fav__seller"', 'item.verified')
    expect(seller).toContain('event.stopPropagation()')
    expect(seller).toContain('act(item, openSeller)')
  })
})
