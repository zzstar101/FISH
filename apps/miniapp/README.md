# @fish/miniapp

FISH 的微信小程序客户端（Taro 4 + React 18 + TypeScript）。第一阶段只有可运行的骨架，**没有业务逻辑**。

## 常用命令

```bash
bun run dev:miniapp      # 等价于 taro build --type weapp --watch
bun run build:miniapp    # 等价于 taro build --type weapp
bun run --filter '@fish/miniapp' typecheck
```

产物在 `dist/`（已 gitignore）。

## 用微信开发者工具打开

打开**仓库里的 `apps/miniapp` 目录**即可：根 `project.config.json` 里的 `miniprogramRoot` 指向
`./dist`，Taro 在构建时会把 `dist/project.config.json` 的 `miniprogramRoot` 改写成 `"./"`。
也可以直接打开 `apps/miniapp/dist`，两者都成立。

AppID 用占位值 `touristappid`。**不要**往仓库里写 AppSecret / Access Token / 私钥。

### 切换到真实 AppID

仓库里始终是 `touristappid`；真实 AppID 构建时注入，只会写进被 gitignore 的 `dist/project.config.json`，
不动源码文件（Taro 的实现：`@tarojs/cli/dist/presets/files/generateProjectConfig.js` 里
`origProjectConfig.appid = process.env.TARO_APP_ID || origProjectConfig.appid`）：

```bash
TARO_APP_ID=wx你的appid bun run build:miniapp
```

注意：`touristappid` 只在微信开发者工具**未登录**（游客模式）时可用。如果工具已登录真实账号，
`cli open` / GUI 打开会报 `不存在此 AppID (code 10)`，必须用上面的方式注入一个有效 AppID。

## 接后端：API 地址怎么给

小程序**没有** `apps/web` 那样的同源代理（Web 靠 `vite.config.ts` 的 `/api` 代理转发），
请求必须写绝对地址。地址在构建期由环境变量注入：

```bash
TARO_APP_API_BASE=https://api.example.com bun run build:miniapp
```

不设置时回落到 `http://localhost:3000`（本机 API），方便在开发者工具里直接跑。
注入点是 `config/index.ts` 的 `defineConstants.__API_BASE__`，读取处是 `src/lib/api-base.ts`。

页面取数一律走 `src/features/fetchers.ts`：**先请求后端，失败或未登录退回本地 mock**，
所以没有后端时页面照样能渲染（评审 / 截图用）。已接接口的页面见 `DESIGN.md` §0。

## 三个容易踩回去的坑

这两处都不是「可选的优化」，改动前请先读完。

### 1. `config/index.ts` 的 `mini.compile.include` 必须放在 `mini` 这一层

`@fish/contracts` 的 `exports` 直接指向 `src/*.ts`（源码即产物）。一旦有代码**值导入**契约，
webpack 会因为「默认不编译 `node_modules` 下的文件」直接报错：

```
ModuleParseError: Module parse failed: Unexpected token
> export type HealthResponse = z.infer<typeof HealthResponseSchema>
```

所以需要把 `packages/contracts/src` 加进 babel-loader 的 `include`。

关键点：写**顶层** `compile` 是无效的。`@tarojs/service@4.2.1` 的 `Config.js#getConfigWithNamed`
只把「白名单字段 + `mini` 块 + 平台块（`weapp`）」合并成 runner 配置，顶层 `compile` 会被静默丢弃，
runner 拿到的 `config.compile` 是空对象 —— 不报错，只是不生效。放在 `mini.compile` 才落到
`MiniWebpackModule.getScriptRule()` 读取的位置。

### 2. 根 `package.json` 的 `@types/react` 固定为 `^19.3.0`

Taro 4.2.1 的 `@tarojs/react` peer 是 `react: ^18`，而 `apps/web` / `packages/ui` 用 React 19，
两个大版本必然并存。小程序引入 React 18 后，bun 会把 lock 里的**默认提升条目**从
`@types/react@19.3.0` 改写成 `18.3.31`，于是 `node_modules/.bun/**` 下第三方包（`cmdk` / `vaul` /
`lucide-react`）的 `.d.ts` 全部解析到 React 18 类型，`@fish/ui` 与 `@fish/web` 立刻报错：

```
error TS2322: Type 'React.ReactNode' is not assignable to type
  '.../node_modules/.bun/@types+react@18.3.31/.../ReactNode'.
  Type 'bigint' is not assignable to type 'ReactNode'.
```

在根 devDependencies 显式声明 `@types/react: ^19.3.0` 可以把默认提升条目钉回 19。
删掉这一行就会复现上面的报错（`apps/web` 与 `packages/ui` 仍各自嵌套 19，但 `.bun/**` 内部的解析已经坏了）。

### 3. 副作用：lock 里「提升默认条目」的 react 变成了 18

引入 React 18 后，`bun.lock` 中 `react` / `react-dom` / `scheduler` 的**提升默认条目**从 19.3.0 变成 18.3.1
（`node_modules/.bun/node_modules/react -> react@18.3.1`）。这是新增一个「受约束更强」的消费者后的正常结果，
且**当前无实际影响**：

- `apps/web` / `packages/ui` 各自嵌套 `react@19.3.0`（`apps/web/dist` 里只有一个 React 实例）
- `@tarojs/react` 与 `@tarojs/plugin-framework-react` 各自嵌套 `react@18.3.1`
- 实测 symlink 统计：75 个指向 `react@19.3.0`，5 个指向 `react@18.3.1`，且 18 的那 5 个都不在 web 的浏览器模块图里

需要注意的只有一件事：**将来在 `apps/web` 侧新增依赖时，不要依赖「提升兜底」拿到 React**，
要在 package.json 里显式声明；否则可能静默拿到 18。
