/**
 * 内滚 `ScrollView` 的 `scrollIntoView` 锚点交替（#581 复核）。
 *
 * 原生层的行为是「`scrollIntoView` 的值没变就不重滚」—— 页面里 `backToTop` 早就为这点
 * 备了两个同位锚点（见 `index.tsx` 的说明），「滚到列表」同样会被人连点第二次。
 * 所以锚点不能写死：每次调用都在两个同位 id 之间交替。抽成纯函数是为了让
 * 「同一个锚点连点两次必须指向不同 id」这条能被用例直接钉住，而不是靠读源码字符串猜。
 */
export const toggleAnchor = (prev: string, a: string, b: string): string => (prev === a ? b : a)
