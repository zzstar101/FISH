import Taro from '@tarojs/taro'

/**
 * 「返回」的统一兜底：页面栈里还有上一页就 `navigateBack`，栈为空则回首页。
 *
 * 栈为空只发生在**冷启动经分享卡片 / 扫码直入二级页**，此时 `navigateBack` 无路
 * 可退，只能回**语义父级 tab**（2026-10-02 拍板）—— 本仓绝大多数二级页的语义父级
 * 是首页。语义父级不是首页的页面（会话页 → 消息、编辑资料 → 我的）由页面经
 * `components/top-bar` 的 `onBack` 自行覆盖，不走这里。
 *
 * 为什么抽成函数：分享卡片把「冷启动直入二级页」变成常态后，这段兜底在
 * `pages/user`、`pages/report-listing`、`pages/report-user`（各 3 处）、
 * `pages/vision-result` 以及 `components/top-bar` / `components/nav-bar` 里被逐字
 * 复刻（#470 review：Duplicated Code）。十份复制意味着改口径要动十个文件，且漏一处
 * 就出现「有的页面点返回没反应、有的页面回首页」。
 */
export function goBackOrHome(): void {
  const pages = Taro.getCurrentPages()
  if (pages.length > 1) {
    void Taro.navigateBack()
  } else {
    void Taro.switchTab({ url: '/pages/home/index' })
  }
}
