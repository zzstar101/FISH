export default definePageConfig({
  navigationBarTitleText: '许愿',
  // #662：Tab 页由 useTabTransition 在 onReady 后显式预热下一页 WebView，
  // 关闭框架默认的 onReady+200ms 自动预加载，避免同一次切页重复建 WebView。
  handleWebviewPreload: 'manual',
})
