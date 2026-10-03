export default definePageConfig({
  navigationBarTitleText: '我的收藏',
  /*
   * 下拉刷新用**微信原生**（与 `pages/home`、`pages/orders-buy` 同一口径）：
   * 页面级滚动 + `usePullDownRefresh`。稿里那套 pointer 事件的假 refresher
   * 是小程序外的演示外壳，不实现（见 `docs/` 与页面文件头）。
   */
  enablePullDownRefresh: true,
  backgroundTextStyle: 'light',
  backgroundColor: '#F7FAFF',
})
