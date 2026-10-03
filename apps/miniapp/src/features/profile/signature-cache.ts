/**
 * 「我的」页签名会话缓存（`savedSig`）的调和规则（纯函数，不依赖 Taro，便于 `bun test` 直接覆盖）。
 *
 * `savedSig` 原本只有一个写入者（本页内联弹窗保存成功），所以「缓存优先于服务端快照」
 * 是安全的。签名有了**第二个写入者**（编辑资料页 `pages/profile-edit`）之后，它保存成功
 * 只广播登录态 store（`applyProfile`），本页的 `savedSig` 不知道 —— 不调和的话，页面会
 * 永久显示缓存里的旧签名，弹窗还会预填旧值、一次「保存」把旧签名原样写回服务端。
 *
 * 规则：store 的 `Me.signature` 只会被**权威的 PATCH 响应**（两位写入者各自保存成功）
 * 与 `GET /me` 更新，因此它一旦与缓存不一致，就说明缓存之后又发生过一次保存 —— 采纳
 * store 值。换号（`forUser` 不匹配）不归这条规则管，由既有的按账号分键失效处理。
 */

/** `savedSig` 的形状：`forUser` 是缓存归属的账号 id，`null` = 本次会话还没保存过。 */
export type SavedSignature = { forUser: string | null; text: string | null }

export function reconcileSavedSignature(
  prev: SavedSignature,
  storeUser: { id: string; signature: string | null },
): SavedSignature {
  if (prev.forUser !== storeUser.id) return prev
  if (prev.text === storeUser.signature) return prev
  return { forUser: prev.forUser, text: storeUser.signature }
}
