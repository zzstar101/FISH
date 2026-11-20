import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { RENTAL_DEPOSIT_NOTICE } from '@fish/contracts/rentals/schema'

/**
 * 租赁页面的**接线守卫**（#706）。
 *
 * 这些断言看起来像「读源码找字符串」，但它们守的是审查实测会静默回归的几件事：
 * 押金免责声明被折叠、价格丢 `¥`、入口开关失效。这三条在端上没法用纯函数测 ——
 * 它们只存在于渲染结构里，所以只能对源码断言（与 `preview-routes.test.ts`、
 * `font-size-scale.test.ts` 同一手法，仓库已有先例）。
 */
const SRC = path.join(import.meta.dir, '..', 'src')
const read = (...segments: string[]) => readFileSync(path.join(SRC, ...segments), 'utf8')

const detailPage = read('pkg-rental', 'pages', 'rental-detail', 'index.tsx')
const squarePage = read('pkg-rental', 'pages', 'rental-square', 'index.tsx')
const homePage = read('pages', 'home', 'index.tsx')

describe('押金说明：详情页必须常驻可见、不折叠', () => {
  test('直接渲染契约里的 full 文案（不是改写后的副本）', () => {
    // 用常量而不是字面量：改写文案会让这条失败，但换行/空白不会。
    expect(detailPage).toContain('RENTAL_DEPOSIT_NOTICE.full')
    // 且不能是「拼出来的一句话」—— 必须整段引用。
    expect(detailPage).not.toContain('RENTAL_DEPOSIT_NOTICE.full.slice')
  })

  test('没有把它包进任何折叠/条件分支', () => {
    // 折叠的实现形态：`{expanded ?` / `{showNotice &&` / `<Collapse`。
    // 这条挡的是「加一个展开更多」这类改动 —— Owner 冻结的是「默认可见、不得折叠」。
    expect(detailPage).not.toMatch(/\{[a-zA-Z]*[Ee]xpanded[^}]*RENTAL_DEPOSIT_NOTICE/)
    expect(detailPage).not.toMatch(/RENTAL_DEPOSIT_NOTICE\.full[^<]*&&/)
  })

  test('契约文案本身没有被改短（防止有人改 schema 绕过上一条）', () => {
    expect(RENTAL_DEPOSIT_NOTICE.full).toContain('不代收、不托管、不垫付、不赔付')
    expect(RENTAL_DEPOSIT_NOTICE.full).toContain('不承担资金责任')
  })
})

describe('价格必须带 ¥ 符号（验收要求 ¥xx/天）', () => {
  test('广场卡片渲染 ¥', () => {
    expect(squarePage).toMatch(/¥\{formatAmount\(/)
  })

  test('详情页渲染 ¥', () => {
    expect(detailPage).toMatch(/¥\{formatAmount\(/)
  })
})

describe('租赁入口开关', () => {
  test('首页入口受 RENTAL_ENTRY_ENABLED 控制', () => {
    // 关掉入口是验收项之一；无条件渲染会让 TARO_APP_RENTAL=0 失效。
    expect(homePage).toContain('RENTAL_ENTRY_ENABLED')
    expect(homePage).toMatch(/\{RENTAL_ENTRY_ENABLED \?/)
  })

  test('开关来自构建常量，且缺省为开', async () => {
    const flag = await import('@/features/rental/flag')
    // 测试环境没有注入 __RENTAL_ENTRY_ENABLED__ → 按「开」处理（漏注入不该让功能消失）。
    expect(flag.RENTAL_ENTRY_ENABLED).toBe(true)
  })
})

describe('租期筛选文案与服端谓词一致', () => {
  test('标签是「可租 N 天」而不是「N 天起」', () => {
    // 服务端是 `minDays <= N <= maxDays`（N 落在区间内），写「起」会误导。
    expect(squarePage).toContain('可租 7 天')
    expect(squarePage).not.toContain('7 天起')
  })

  test('切 chip 时把新值显式传给查询（不能只 setState 后读闭包）', () => {
    // 审查实测的 bug：`setDays(v)` + `setTimeout(load)` 会读到旧的 days。
    expect(squarePage).toMatch(/load\(\{\s*days: option\.value/)
  })
})
