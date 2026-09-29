/**
 * UUID 形状校验（服务端侧兜底）。
 *
 * 为什么不复用 `@fish/shared/public-id` 的 `decodePublicId`：那条路径只接受**规范 UUIDv7**
 * （公开 id 的编码规则，见 `packages/shared/src/public-id.ts:26`）。这里要校验的是两类原始 UUID：
 * 服务端生成的 `requestId`（v7）与客户端生成的 `eventId` / 匿名会话标识（v4）——
 * v4 会被 `decodePublicId` 直接拒掉，用它做形状检查等于把合法客户端 id 判成非法。
 *
 * 为什么不引入 zod：`apps/api` 不依赖 zod（契约校验在 `@fish/contracts` 内完成，
 * 服务端只在**边界之外**做形状兜底）。为一个正则加一个依赖不值得，也与既有做法一致
 * （如 `apps/api/src/modules/messages/system-content.ts:5` 的 `UUID_V7` 常量）。
 *
 * 只校验形状、不校验版本位：这里的值要么来自契约已校验的 body，要么来自请求头/游标，
 * 而它们最终都被绑到 PostgreSQL 的 uuid 列上——形状不对就是查不到行（→ 422），
 * 不会造成 SQL 错误，也不需要在这里复刻 RFC 9562 的版本语义。
 */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isUuidShape(value: string): boolean {
  return UUID_SHAPE.test(value)
}
