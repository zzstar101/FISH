export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/wish/index',
    'pages/wish-publish/index',
    'pages/sell/index',
    'pages/chat/index',
    'pages/profile/index',
    'pages/search/index',
    'pages/listing-detail/index',
    'pages/conversation/index',
    'pages/orders-buy/index',
    'pages/orders-sell/index',
    'pages/transaction-meetup/index',
    'pages/register/index',
    'pages/register-success/index',
    'pages/login/index',
    'pages/settings/index',
    'pages/verify/index',
    'pages/user/index',
    'pages/match/index',
    'pages/mylist/index',
    'pages/watchers/index',
    'pages/scan/index',
    'pages/following/index',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationStyle: 'custom',
    backgroundColor: '#F7FAFF',
    navigationBarBackgroundColor: '#F7FAFF',
    navigationBarTitleText: '鱼小应',
    navigationBarTextStyle: 'black',
  },
  tabBar: {
    /**
     * **自定义 TabBar**：`custom: true` 让微信不再渲染原生底栏，改由
     * `src/custom-tab-bar/` 这个**固定目录名**里的组件接管（Taro 4 约定，
     * 见 @tarojs/webpack5-runner 的 MiniPlugin.js「自定义 tabBar」）。
     *
     * 为什么这么做：设计稿的底栏是「居中悬浮玻璃胶囊 + 中间凸起发布钮」，
     * 原生 TabBar 只能整条贴底、不支持圆角悬浮与凸起。自定义之后
     * `Taro.hideTabBar()` 那套 workaround 也不需要了。
     *
     * `list` 仍然必须保留：它是 `Taro.switchTab` 的合法路由表，也是自定义
     * TabBar 里 `selected` 索引的依据。`text`/图标不再由系统渲染。
     */
    custom: true,
    color: '#71809C',
    selectedColor: '#4285FF',
    backgroundColor: '#FFFFFF',
    borderStyle: 'white',
    list: [
      { pagePath: 'pages/home/index', text: '首页' },
      { pagePath: 'pages/wish/index', text: '许愿' },
      { pagePath: 'pages/sell/index', text: '出物' },
      { pagePath: 'pages/chat/index', text: '消息' },
      { pagePath: 'pages/profile/index', text: '我的' },
    ],
  },
})
