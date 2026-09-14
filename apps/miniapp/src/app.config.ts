export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/wish/index',
    'pages/sell/index',
    'pages/chat/index',
    'pages/profile/index',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: 'FISH',
    navigationBarTextStyle: 'black',
  },
  tabBar: {
    color: '#8a8a8e',
    selectedColor: '#3b6ea5',
    backgroundColor: '#ffffff',
    borderStyle: 'black',
    list: [
      { pagePath: 'pages/home/index', text: '首页' },
      { pagePath: 'pages/wish/index', text: '许愿' },
      { pagePath: 'pages/sell/index', text: '卖闲置' },
      { pagePath: 'pages/chat/index', text: '消息' },
      { pagePath: 'pages/profile/index', text: '我的' },
    ],
  },
})
