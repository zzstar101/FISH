export default definePageConfig({
  /*
   * 顶部回归 app 级的自绘导航（app window 是 `navigationStyle: 'custom'`，页面不再
   * 覆盖）：顶栏由 `components/order-list` 里的 `components/top-bar` 玻璃栏承担
   * （#386 第一批，与「我的发布」同款），视角词「我买到的」由顶栏标题表达。
   * 两个视角仍是两个页面，没有视角切换控件，入口在「我的」页（见 `pages/profile`）。
   *
   * `navigationBarTitleText` 在 custom 导航下仍生效于微信最近使用卡片 / 任务切换器的
   * 页面标题（同 `pages/mylist` 的先例），所以保留。
   */
  navigationBarTitleText: '我买到的',
  // 订单列表是页面级滚动，下拉刷新语义成立（先例：pages/home/index.config.ts）
  enablePullDownRefresh: true,
  backgroundColor: '#F7FAFF',
  backgroundTextStyle: 'light',
})
