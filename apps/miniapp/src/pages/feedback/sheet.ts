/**
 * 意见反馈「提交结果」弹层的**正文档位**（Taro-free，可直接单测）。
 *
 * 为什么单独一个文件：弹层是页面对用户的承诺，正文必须**只说成立的话** ——
 * 后端 `POST /feedback` 不存在、客服邮箱待定（稿里用虚线标出的占位），
 * 这两件事决定了「你的内容已暂存在本机」「可直接复制后通过客服邮箱发给我们」
 * 这两句什么时候能说、什么时候不能说。把档位判定摘出来，`tests/feedback-sheet.test.ts`
 * 才能钉住它 —— 否则把某个分支删掉，typecheck / lint / 测试全绿，回归不会红。
 *
 * ⚠️ **未定内容页面**：三档正文都是初稿，**实际文案由 zzstar 决策**；
 * 客服邮箱一旦在 `pages/feedback/index.tsx` 的 `SUPPORT_MAIL` 上填好，
 * `with-mail` 这一档（稿的原文）会自动生效。
 */

/** 弹层正文档位：暂存失败 / 邮箱已定（稿原文）/ 邮箱未定 */
export type SheetVariant = 'stored-failed' | 'with-mail' | 'no-mail'

/**
 * 选档：
 * - `stored === false`（`Taro.setStorageSync` 抛错）→ 不能说「已暂存在本机」；
 * - 否则看客服邮箱定没定。
 *
 * `stored === null`（还没提交过）只会在弹层没打开时出现，取「邮箱」那两档即可。
 */
export function sheetVariant(stored: boolean | null, hasMail: boolean): SheetVariant {
  if (stored === false) return 'stored-failed'
  return hasMail ? 'with-mail' : 'no-mail'
}

/** 正文片段：`b` = 加粗（渲染成品牌深色强调，与稿的 `<strong>` 对应） */
export type SheetRun = { t: string; b?: boolean }

/**
 * 三档正文。
 *
 * `no-mail` 一档刻意**不说「没有可用的送达渠道」这种全局判断**：同屏页头（稿原文）写着
 * 「你的反馈我们会逐条阅读…会通过你留下的联系方式与你联系」，那说的是产品意图；
 * 这里只描述**这一次提交**送不出去，两句话就不会在同一张屏上互相打脸。
 */
export const SHEET_BODY: Record<SheetVariant, SheetRun[]> = {
  'stored-failed': [
    { t: '本机暂存失败', b: true },
    { t: '，请先把上面写好的内容复制到别处，再离开本页。' },
  ],
  'with-mail': [
    { t: '后端反馈接口尚未上线。' },
    { t: '你的内容已暂存在本机', b: true },
    { t: '，可直接复制后通过下面的客服邮箱发给我们。' },
  ],
  'no-mail': [
    { t: '后端反馈接口尚未上线，这一次提交还送不出去。' },
    { t: '你的内容已暂存在本机', b: true },
    { t: '；客服邮箱待定，定稿后这里会给出可复制的邮箱。' },
  ],
}
