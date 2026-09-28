import { UserAvatar } from '@fish/ui/user-avatar'

/**
 * 首页「优质商家」推荐位。
 *
 * ⚠️ 平台当前没有商家 / 店铺模型：契约里只有「卖家 = 商品发布者」
 * （`packages/contracts/src/listings/schema.ts` 的 `ListingSellerSchema`），
 * 没有评分、销量、认证、粉丝等字段；首页商品卡（`ListingCardSchema`）也不带 seller。
 * 所以这里是**本地维护的展示位**，不是真实业务数据。
 *
 * 接真实数据需要先有契约 + API（并会进入小程序端的验证范围），届时替换 `TOP_SELLERS`
 * 的来源即可。卡片只写中性信息，不编造评分 / 销量 / 成交等指标。
 */
const TOP_SELLERS = [
  { id: 'seller-1', name: '阿岚的书架', focus: '教材 · 考研资料' },
  { id: 'seller-2', name: '小林数码', focus: '耳机 · 显示器 · 键鼠' },
  { id: 'seller-3', name: '宿舍好物铺', focus: '收纳 · 小家电' },
  { id: 'seller-4', name: '骑行驿站', focus: '自行车 · 骑行装备' },
] as const

export function TopSellers() {
  return (
    <section aria-labelledby="top-sellers-title" className="mt-9">
      <div className="mb-4">
        <h2 className="font-semibold text-[22px] tracking-[-0.03em]" id="top-sellers-title">
          优质商家
        </h2>
        <p className="mt-1.5 text-ink-3 text-sm">校内活跃卖家 · 全程站内沟通</p>
      </div>

      <div className="grid grid-cols-4 gap-5">
        {TOP_SELLERS.map((seller) => (
          <article className="rounded-2xl border border-line bg-surface p-6" key={seller.id}>
            <div className="flex items-center gap-3">
              <UserAvatar emoji={seller.name.slice(0, 1)} />
              <div className="min-w-0">
                <p className="truncate font-semibold">{seller.name}</p>
                <p className="mt-1 truncate text-ink-3 text-xs">{seller.focus}</p>
              </div>
            </div>
            <p className="mt-4 inline-flex whitespace-nowrap rounded-full bg-brand-soft px-3 py-1 font-medium text-brand text-xs">
              校内面交
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}
