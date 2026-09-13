/**
 * 许愿墙 Banner 的「热门求购标签」。
 *
 * 真实 `/wishes` 契约里**没有**「热门标签」这个概念（`packages/contracts/src/wishes/schema.ts`
 * 只有愿望本体与愿望池），所以这份榜单是**纯前端常量**：既不经过 mock store，也不需要后端配合。
 * 等后端真的提供聚合口径（「最常被求购的关键词」）时，再把它换成接口数据。
 *
 * 维护这份列表要守住两条：
 *
 * 1. **必须按 `wanters` 降序排列**。数组顺序即名次，展示层不做排序；顺序错了就会渲染出
 *    「第 4 名比第 3 名人多」的榜单。
 * 2. **每个 `label` 都会被当成搜索关键词**（跳 `/search?kw=<label>`），所以它应当能在真实
 *    库存里搜到东西。
 *
 * ⚠️ 关于第 2 条的现实情况（2026-09 实测）：`packages/db/src/seed.ts` 只有 6 件商品
 * （罗技键盘 / Redmi 显示器 / 高等数学教材 / 宿舍台灯 / 斯伯丁篮球 / 匡威帆布鞋），
 * 开发库上还混着接口验收写入的临时数据；直接打 `/listings?q=` 实测，只有「键盘 / 显示器 /
 * 帆布鞋 / 高等数学」等少数词有结果，本列表里大部分标签会落到搜索空态。
 * 也就是说：**这份榜单目前是编辑内容，不是库存的映射**。要让每个标签都点得通，
 * 需要产品侧二选一——(a) 把标签收敛到真实在售品类，或 (b) 由后端提供聚合口径
 * （最常被求购的关键词）后改成接口数据；在那之前不要按「必须有结果」来增删本列表。
 */
export type HotWishTag = {
  /** 标签文案，同时作为搜索关键词。 */
  label: string
  /** 想要它的人数；数组必须按它降序。 */
  wanters: number
}

export const HOT_WISH_TAGS: HotWishTag[] = [
  { label: '考研数学', wanters: 42 },
  { label: 'iPad', wanters: 38 },
  { label: '人体工学椅', wanters: 27 },
  { label: '游戏本', wanters: 24 },
  { label: '降噪耳机', wanters: 21 },
  { label: '键盘', wanters: 17 },
  { label: '雅思真题', wanters: 13 },
  { label: '尤克里里', wanters: 11 },
  // 以下 4 条在折叠区，由「展示全部」展开。
  { label: '考研政治', wanters: 9 },
  { label: '鼠标', wanters: 8 },
  { label: '台灯', wanters: 7 },
  { label: 'Switch', wanters: 6 },
]
