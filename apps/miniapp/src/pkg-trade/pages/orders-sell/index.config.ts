export default definePageConfig({
  // 顶部回归 app 级自绘导航（同 pages/orders-buy，#386 第一批）：玻璃顶栏在
  // components/order-list 里，视角词「我卖出的」由顶栏标题表达。
  // navigationBarTitleText 供微信最近使用卡片 / 任务切换器显示（custom 导航下仍生效，
  // 同 pages/mylist 的先例）
  navigationBarTitleText: '我卖出的',
  // 订单列表是页面级滚动，下拉刷新语义成立（先例：pages/home/index.config.ts）
  enablePullDownRefresh: true,
  backgroundColor: '#F7FAFF',
  backgroundTextStyle: 'light',
})
