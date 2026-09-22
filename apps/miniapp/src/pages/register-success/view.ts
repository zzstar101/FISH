/**
 * 注册成功页的展示层映射：**认证状态 → 文案 + 主按钮出口**（#177 审查收口）。
 *
 * 单独成模块的理由与 `pages/mylist/list.ts` 相同：页面组件自己拖着 Taro
 * （`showToast` / `navigateTo` / `switchTab`），没法直接单测；但这一页真正需要被锁住的
 * 「认证状态 → 页面说什么」，是纯函数。上一轮审查卡住的正是这层 —— 已认证分支曾一边
 * 渲染「已认证 · 校园身份已核验」，一边把主按钮写成「去校园认证」，同一屏自相矛盾。
 *
 * 本模块只锁映射本身；页面是否真的拿 `view.*` 渲染，靠 code review（同 `mylist-list.test.ts`
 * 的口径：本仓 `tests/` 只有纯逻辑测试，没有 Taro 组件渲染基建）。
 *
 * 稿值出处：`1改/校园认证页面（包括注册跳转页面）.html` 的 `renderRegister()`
 * —— 00 帧静态只画未认证态，已认证态的 `#regDesc` / `#regPill` / `#regPrimary` / `#regNote`
 * 四处由该函数按 `S.verified` 给出（无独立帧）。
 */

export type RegisterSuccessView = {
  /** 状态描述（稿 `#regDesc`） */
  desc: string
  /** 描述里单独加重的词（稿的 `<b>`，两个分支都加重） */
  emphasis: string
  /** 状态胶囊（稿 `#regPill`） */
  badge: string
  /** 胶囊是否用已认证（ok）配色 —— 与 `badge` 同源，避免页面自己再判一次 */
  ok: boolean
  /** 主按钮文案（稿 `#regPrimary`） */
  primaryCta: string
  /** 脚注（稿 `#regNote`） */
  note: string
}

/**
 * 认证状态 → 页面文案。
 *
 * 已认证分支是**防御性**的：注册出来的账号按契约恒为 UNVERIFIED，正常路径不会命中，
 * 但用户从历史栈回到这一页、或在别处完成认证后会命中。只要它会渲染，就不能再请用户
 * 「去校园认证」，也不能再说「稍后去完成认证」。
 *
 * 已认证分支的脚注**刻意不照抄稿的**「如需更换邮箱，需先解除当前认证」：自助解绑 / 换绑
 * 能力尚未落地（产品与安全语义仍在 #86 冻结中），#86 的要求是「UI 在能力未落地前不得
 * 暗示可以自行解除认证」，故该分支改为只陈述现状与查看入口。
 *
 * 两个分支的主按钮**都进校园认证页**：那里已认证时会渲染成功态（脱敏邮箱 + 认证时间），
 * 与稿的 `regPrimary` 点击行为一致（稿 `if (S.verified) setPage(3)`，3 即已认证帧）。
 */
export function registerSuccessView(verified: boolean): RegisterSuccessView {
  if (verified) {
    return {
      desc: '账号已创建并自动登录。当前状态为',
      emphasis: '已认证',
      badge: '已认证 · 校园身份已核验',
      ok: true,
      primaryCta: '查看认证状态',
      // 与未认证分支同一句法（稿 `#regNote` 的写法）：都在说「去『我的』页的校园认证入口」
      // —— 那里点认证胶囊进本页，已认证时显示成功态。不写死子菜单路径，避免与另一分支不一致
      note: '认证信息可在「我的 → 校园认证」查看',
    }
  }

  return {
    desc: '账号已创建并自动登录。当前状态为',
    emphasis: '未认证',
    badge: '未认证 · 待完成校园认证',
    ok: false,
    primaryCta: '去校园认证',
    note: '也可以稍后在「我的 → 校园认证」完成',
  }
}
