export default definePageConfig({
  navigationBarTitleText: '我的关注',
  /*
   * 下拉刷新用**微信原生**（方案 §1.4）：页面级滚动，语义成立。
   * 先例 `pages/home` / `pages/orders-buy`；稿里手写 pointer 事件的假 refresher 不复刻。
   */
  enablePullDownRefresh: true,
  backgroundColor: '#F7FAFF',
  backgroundTextStyle: 'light',
})
