export default definePageConfig({
  // 顶部用微信原生导航栏（同 pages/orders-buy），标题是视角本身
  navigationStyle: 'default',
  navigationBarTitleText: '我卖出的',
  // 订单列表是页面级滚动，下拉刷新语义成立（先例：pages/home/index.config.ts）
  enablePullDownRefresh: true,
  backgroundColor: '#F7FAFF',
  backgroundTextStyle: 'light',
})
