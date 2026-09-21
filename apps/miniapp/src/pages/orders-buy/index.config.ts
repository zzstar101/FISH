export default definePageConfig({
  /*
   * 顶部用微信原生导航栏：app 级 window 是 `navigationStyle: 'custom'`（全局自绘导航），
   * 这两页按 Owner 定版覆盖回原生栏，标题就是视角本身（我买到的 / 我卖出的）。
   * 因此页面里不再有自绘顶栏，也没有视角切换控件 —— 两个视角是两个页面，
   * 入口在「我的」页（见 `pages/profile`）。
   */
  navigationStyle: 'default',
  navigationBarTitleText: '我买到的',
  // 订单列表是页面级滚动，下拉刷新语义成立（先例：pages/home/index.config.ts）
  enablePullDownRefresh: true,
  backgroundColor: '#F7FAFF',
  backgroundTextStyle: 'light',
})
