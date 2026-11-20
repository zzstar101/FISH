/**
 * 租赁入口开关（#706 验收项「租赁入口可关闭」）。
 *
 * 默认**开**；构建时给 `TARO_APP_RENTAL=0` 关掉后，首页的「租赁广场」二级入口不渲染。
 *
 * ## 关闭入口 ≠ 下线页面
 *
 * 关掉之后 `pkg-rental` 的三个页面**仍可直接访问**（分享链接、历史会话、已打开的页面栈）。
 * 这是刻意的：已发布的出租、在途会话与已收藏的链接必须继续可读 —— #713 的灰度回滚要求
 * 「关闭新增入口和新预约后，已接单订单仍可查看、归还和申诉」。真正的服务端 kill switch
 * （`RENTAL_V1_ENABLED`，拒绝新写入）归 #713。
 *
 * ## 为什么用构建常量而不是服务端配置
 *
 * 端上开关只控制**入口是否露出**，不承担权限语义 —— 服务端的资格、品类、租期校验一条不少。
 * 用构建常量就不必为一次「先别露出入口」多发一个配置请求，也不会出现「开关拉取失败
 * 时入口闪一下」。
 */
declare const __RENTAL_ENTRY_ENABLED__: boolean | undefined

/**
 * 首页是否显示租赁广场入口。
 *
 * `undefined`（预览壳 / 测试环境没注入该常量）按**开**处理：漏注入常量不该让功能消失，
 * 与 `load-failure.ts` 对 `__ALLOW_MOCK_FALLBACK__` 的缺省口径相反 —— 那边缺省必须关
 * （避免假数据进生产），这边缺省必须开（避免功能被一个配置疏漏藏起来）。
 */
export const RENTAL_ENTRY_ENABLED: boolean =
  // `typeof` 保护：bun test / 预览壳没有注入这个常量，直接读会抛 ReferenceError。
  typeof __RENTAL_ENTRY_ENABLED__ === 'undefined' ? true : __RENTAL_ENTRY_ENABLED__ !== false
