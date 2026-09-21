/**
 * 签名的展示口径（纯函数，不依赖 Taro 运行时 —— 便于 `bun test` 直接覆盖）。
 *
 * 与存储（`signature.ts`）分开是因为存储必须 `import Taro`，而 Bun 下加载 Taro 会抛
 * `ENABLE_INNER_HTML is not defined`（实测）；展示口径是 Owner 明确的验收点，
 * 值得有自动化防线。
 */

/**
 * 只取**首行**：用户可能输入多行（粘贴带换行），页内与「他人视角主页」都只展示首行，
 * 过长由 CSS `text-overflow: ellipsis` 在行尾补省略号。
 *
 * `\r\n` 的 `\r` 由 `trim()` 吃掉；首行全是空白（或整体为空）时返回空串，调用方按
 * 「未设置」渲染占位。
 */
export function signatureFirstLine(text: string): string {
  const [first = ''] = text.split('\n')
  return first.trim()
}
