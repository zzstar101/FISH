/**
 * 通知的展示层组装（文案 / 跳转目标 / tone）：**零 fixture 依赖**的生产模块。
 *
 * 为什么从 `mock/api.ts` 挪出来：真实接口的**成功路径**也要用它
 * （`features/fetchers.ts` 的 `loadNotifications`），留在 `@/mock/api` 会让整包
 * fixture 被静态拖进生产包的模块图。这里把「拿 listingId 查商品标题」的能力做成
 * 显式参数 `resolve`，本文件不 import 任何 `@/mock/*` 的运行期值。
 *
 * 通知文案 / 跳转目标由前端按 `type` + `payload` 组装（#23：服务端不存文案）。
 *
 * 放在数据层而不是页面里：改文案不用碰 UI；换真实接口时把 title/description
 * 从服务端替进来即可。目标商品已删除/下架时退回愿望页，而不是给一个点不动的死入口。
 *
 * `resolve` 是「拿 listingId 查商品标题」的能力：fixture 场景由 `@/mock/api` 传
 * `findListing`，**真实接口的数据必须显式传 `null`**，原因见 `decorateNotifications`
 * 的注释。
 */
import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { formatAmount } from '@/lib/money'
import type { MockListing, MockNotification } from '@/mock/types'

function decorateNotification(
  item: NotificationDto,
  resolve: ((listingId: string) => MockListing | undefined) | null,
): MockNotification {
  if (item.type === 'MATCH') {
    const listingId = item.payload.listingId
    const listing = listingId && resolve ? resolve(listingId) : undefined
    const wishId = item.payload.wishId

    // 没有查询能力时（真实接口）只能给通用文案 + 原地板的跳转目标。
    // 不能因为「查不到标题」就说「已被下架」—— 那是把「不知道」说成了「不存在」。
    if (!resolve) {
      return {
        ...item,
        title: '有新的匹配',
        description: '',
        tone: 'mint',
        target: listingId
          ? { kind: 'listing', listingId }
          : wishId
            ? { kind: 'wish', wishId }
            : null,
      }
    }

    return {
      ...item,
      title: listing ? '你要的闲置出现了' : '有新的匹配',
      description: listing
        ? `${listing.title} · ¥${formatAmount(listing.priceCents)}`
        : '这条匹配对应的商品已经被下架了',
      tone: listing ? 'mint' : 'warn',
      target:
        listing && listingId
          ? { kind: 'listing', listingId }
          : wishId
            ? { kind: 'wish', wishId }
            : null,
    }
  }
  // 契约 P0 只有 MATCH；#14 扩 type 时在这里加分支，页面不用动。
  if (item.type === 'TX') {
    // 收件人由产生点决定（契约注释）：事件即隐含视角，文案按事件写死对谁说。
    const conversationId = item.payload.conversationId
    return {
      ...item,
      title: '交易进展',
      description:
        item.payload.event === 'PROPOSED'
          ? '买家发起了交易确认，等你接受'
          : item.payload.event === 'ACCEPTED'
            ? '卖家接受了你的交易确认，去安排面交吧'
            : item.payload.event === 'REJECTED'
              ? '卖家拒绝了你的交易确认'
              : item.payload.event === 'CONFIRMED'
                ? '对方已确认面交，等你确认'
                : item.payload.event === 'COMPLETED'
                  ? '交易已完成'
                  : item.payload.event === 'CANCELLED'
                    ? '交易已取消'
                    : '',
      tone:
        item.payload.event === 'ACCEPTED' || item.payload.event === 'COMPLETED' ? 'mint' : 'warn',
      target: conversationId ? { kind: 'conversation', conversationId } : null,
    }
  }
  if (item.type === 'MODERATION') {
    // 审核结果：跳「我的发布」看详情（Owner 口径：MODERATION → 我的发布）。
    // `outcome` 在契约里是**可选**的（历史行 / 脏 payload 读不到：见
    // `notifications/schema.ts` 的 `notificationOutcomeSchema`）。缺省或非法值
    // **绝不能**落进「未通过」分支 —— 那等于替服务端宣布商品被拒审。三态处理：
    // 只有明确的 `REJECTED` 才说未通过，读到什么都认不出来时给中性文案。
    const outcome = item.payload.outcome
    const approved = outcome === 'APPROVED'
    const rejected = outcome === 'REJECTED'
    return {
      ...item,
      title: approved ? '商品审核通过' : rejected ? '商品未通过审核' : '商品审核有更新',
      description: approved
        ? '你的闲置已重新上架可见'
        : rejected
          ? '到「我的发布」查看原因并编辑重发'
          : '到「我的发布」查看这条商品的当前状态',
      tone: approved ? 'mint' : 'warn',
      target: { kind: 'mylist' },
    }
  }
  if (item.type === 'ACCOUNT') {
    // 同 MODERATION：缺省 / 非法 `outcome` 不得渲染成「未通过」，只给中性结果文案。
    const outcome = item.payload.outcome
    const approved = outcome === 'APPROVED'
    const rejected = outcome === 'REJECTED'
    return {
      ...item,
      title: item.payload.subject === 'VERIFICATION' ? '校园认证' : '账号通知',
      description: approved
        ? '校园认证通过，享受认证用户权益'
        : rejected
          ? '校园认证未通过，可重新验证'
          : '认证结果有更新，可到认证页查看',
      tone: approved ? 'mint' : 'warn',
      target: item.payload.subject === 'VERIFICATION' ? { kind: 'verify' } : null,
    }
  }
  return { ...item, title: '新通知', description: '', tone: 'warn', target: null }
}

/**
 * 给一批通知补上文案与跳转目标。
 *
 * `resolve` 传函数时按 listingId 回查商品标题（演示 / 回退路径）；传 `null` 表示
 * 「确实没有查询能力」（真实接口路径）—— 此时只给通用文案并保留由 `payload`
 * 推出的跳转目标，**不谎称商品已下架**。
 * 这样「接真接口」与「退 mock」两条路都不会把「查不到」渲染成「不存在」。
 */
export function decorateNotifications(
  items: NotificationDto[],
  resolve: ((listingId: string) => MockListing | undefined) | null,
): MockNotification[] {
  return items.map((item) => decorateNotification(item, resolve))
}
