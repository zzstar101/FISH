/**
 * 「待确认」段落的纯渲染决策。
 *
 * 抽出来是因为本端没有 jsdom、组件只做静态渲染，而这里的**优先级**有实质内容：
 * 用户刚做完的决定（notice）不能被随后那次重读的失败吞掉 —— 那会让他既不知道
 * 同意是否生效，也拿不到「去我卖出的出示交易码」这个唯一取码入口。
 */

export type PendingSectionMode =
  /** 整段不渲染（没有申请，也没有话要说） */
  | 'hidden'
  /** 读不到 / 推导整轮失败：必须显式说明「没有申请」≠「读不到」 */
  | 'error'
  | 'loading'
  /** 有申请，或刚做完决定要留话说 */
  | 'list'

export function pendingSectionMode(state: {
  isError: boolean
  /** 推导整轮没读到（`PendingIndex.failed`） */
  failed: boolean
  isPending: boolean
  proposalCount: number
  hasNotice: boolean
}): PendingSectionMode {
  // 错误先于 loading：重读失败时 isPending 可能已经落回 false，
  // 而「读不到」这个事实比加载态更需要说出口。
  if (state.isError || state.failed) return 'error'
  if (state.isPending) return 'loading'
  if (state.proposalCount === 0 && !state.hasNotice) return 'hidden'
  return 'list'
}
