/**
 * 演示态的他人签名注入表（Owner 2026-09-22 拍板「mock 先行」）。
 *
 * **这是演示口径，不是产品实现**：他人签名在后端三层都没有（DB 无列 / 契约无字段 /
 * 无端点，原 #143 已 CLOSED/NOT_PLANNED 并入 #86），后端缺口另开 Issue。这里只做
 * 「演示时能看见签名行」的最小替身：
 *
 * - **键是真实 uuid**（seed 三账号）：只对这三个 id 生效，其它任何用户签名行照旧
 *   不渲染 —— 不会把演示签名挂在真实用户名下。
 * - **只在演示构建生效**：调用方必须以 `MOCK_FALLBACK_ENABLED` 为闸（与
 *   `fetchers.ts` 的 mock 回退同一开关），且页面再加一层 seed 用户白名单。生产构建
 *   闸恒为 false，签名行与关注钮都不渲染（`__ALLOW_MOCK_FALLBACK__` 由 `config/index.ts`
 *   注入）。⚠️ 这是**渲染层**的边界，不是打包层的：`pages/user` 静态 import 本模块，
 *   所以这张表在生产包里也存在 —— 被挡住的是「显示出来」，不是「进不进 bundle」。
 * - **不碰本机存储**（`features/profile/signature.ts` 的键按本人 id 分，读出来
 *   是当前登录用户自己的签名，给别人看是隐私错误）。
 *
 * 内容取自 1版稿的演示数据（`小程序1版user.html` USERS 表），仅改用演示账号的
 * 昵称语境；稿里的 `@stu.edu.cn` 等通用模板文案不照抄。
 */
export const DEMO_SIGNATURES: Record<string, string> = {
  /** seed 卖家 A · 阿岚（49 字，明显超一行 → 折叠 + 箭头，展开有效果） */
  '01930000-0000-7000-8000-00000000000a':
    '计算机科学与技术 · 数码爱好者，常年出闲置。支持广州校区当面自提，价格好商量，急出的小刀也可以～',
  /** seed 买家 B · 小北（15 字，一行放得下 → 不给箭头） */
  '01930000-0000-7000-8000-00000000000b': '大一新生，出点用不上的小东西。',
  /** seed 买家 C · 橙子（演示「多行只显首行」：第二行被 signatureFirstLine 丢掉，页内看不到） */
  '01930000-0000-7000-8000-00000000000c': '毕业清仓，教材、日用品都在出。\n谢谢大家照顾～',
}

/**
 * 演示账号 id（= 上表的键）。关注钮也用它当白名单：那颗钮是纯演示、没有数据面，
 * 只该出现在演示账号的主页上，不能挂在任意真实用户页上（`MOCK_FALLBACK_ENABLED`
 * 在 `NODE_ENV === 'development'` 下也为真，见 `config/index.ts`）。
 */
export const DEMO_USER_IDS: readonly string[] = Object.keys(DEMO_SIGNATURES)
