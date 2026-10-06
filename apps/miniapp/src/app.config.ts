export default defineAppConfig({
  // 主包只保留 5 个 tab 页（微信不允许 tab 页进分包），其余页面按业务域拆进 6 个分包。
  // 分包根目录 = `src/pkg-<group>/`，页面在 `src/pkg-<group>/pages/<page>/`。
  pages: [
    'pages/home/index',
    'pages/wish/index',
    'pages/sell/index',
    'pages/chat/index',
    'pages/profile/index',
  ],
  lazyCodeLoading: 'requiredComponents',
  subPackages: [
    {
      root: 'pkg-browse',
      pages: [
        'pages/listing-detail/index',
        'pages/mylist/index',
        'pages/match/index',
        'pages/watchers/index',
        'pages/comments/index',
        'pages/favorites/index',
        'pages/history/index',
        'pages/search/index',
        'pages/user/index',
        'pages/following/index',
      ],
    },
    {
      root: 'pkg-trade',
      pages: [
        'pages/transaction-meetup/index',
        'pages/report-listing/index',
        'pages/report-user/index',
        'pages/my-reports/index',
        'pages/send-listing/index',
        'pages/orders-buy/index',
        'pages/orders-sell/index',
      ],
    },
    {
      // 静态法务与帮助页（未定内容页面，实际内容由 zzstar 决策）：
      // 关于与版本 / 用户协议 / 隐私政策 / 意见反馈 —— 一批一起落，入口在
      // 「我的 → 帮助与设置」与设置页「关于」组，另由登录页协议勾选行带 `?from=login` 进入
      root: 'pkg-legal',
      pages: [
        'pages/privacy/index',
        'pages/terms/index',
        'pages/feedback/index',
        'pages/about/index',
      ],
    },
    {
      root: 'pkg-social',
      pages: ['pages/conversation/index', 'pages/wish-publish/index'],
    },
    {
      root: 'pkg-auth',
      pages: [
        'pages/verify/index',
        'pages/settings/index',
        'pages/account-deletion/index',
        'pages/profile-edit/index',
        'pages/login-confirm/index',
        'pages/login/index',
      ],
    },
    {
      root: 'pkg-vision',
      pages: [
        'pages/vision-result/index',
        'pages/scan-vision/index',
        'pages/scan-pr/index',
        'pages/scan/index',
      ],
    },
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
