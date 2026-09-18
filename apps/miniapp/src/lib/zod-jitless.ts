/**
 * 关掉 zod v4 的 JIT —— 小程序运行时下它必炸。
 *
 * ## 现象
 *
 * `ApiErrorSchema.safeParse(...)`、`AuthResponseSchema.parse(...)` 这类调用会抛
 * `TypeError: n is not a function`，栈顶落在 zod 的 `compile` 里（压缩后是 `k.compile`）。
 *
 * ## 原因
 *
 * zod v4 默认给 object schema 生成一个 `new Function` 的「快速解析器」（fastpass）。
 * 它的**探针**只试 `new Function("")`（`zod/v4/core/util.js` 的 `allowsEval`），这一步在小程序
 * 的 appservice 里能过，于是 JIT 路径被启用；但真正生成/执行解析器时，生成代码引用的内部符号
 * 在 webpack 压缩产物里已经对不上，才在 `compile` 里炸掉。
 *
 * ## 影响面
 *
 * **所有**走 `packages/contracts` 的解析，也就是 `features/<域>/api.ts` 的每个请求。此前它一直被
 * `features/fetchers.ts` 的「失败退 mock」盖着 —— 表现成「接口明明通了，页面却总是退 mock」，
 * 很容易被误判成后端或网络问题。
 *
 * ## 生效时机（关键）
 *
 * zod 在**构造 schema 时**读 `globalConfig.jitless`（`schemas.js`：`const jit = !core.globalConfig.jitless`），
 * 所以本模块必须在任何契约模块（`@fish/contracts/**`）之前被求值。
 * `app.ts` 与 `lib/request.ts` 都把它放在**第一条 import**，覆盖这两条入口。
 *
 * 另外这里**改写的是同一个对象**（`??=` 取到就改，取不到才建），不是替换成新对象：
 * zod 的 `globalConfig` 是 core 求值时捕获的**引用**（`zod/v4/core/core.js`：
 * `globalThis.__zod_globalConfig ?? (_a.__zod_globalConfig = {})`）——
 * 一旦 core 先求值，替换引用就永久失效、静默退回会崩的 JIT，而改写对象两种顺序都成立。
 *
 * 本模块**零 import**，因此不存在「先初始化 zod、再设配置」的循环依赖问题；
 * 但「谁先跑」仍取决于 import 顺序，见上。
 */

const globalWithZod = globalThis as typeof globalThis & {
  __zod_globalConfig?: Record<string, unknown>
}

// 取到就改（同一对象），取不到才建 —— 不能用 `??=`：biome 禁「表达式里赋值」，也不够直白
let config = globalWithZod.__zod_globalConfig
if (!config) {
  config = {}
  globalWithZod.__zod_globalConfig = config
}
config.jitless = true
