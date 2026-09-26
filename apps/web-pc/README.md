# @fish/web-pc

FISH 的 PC 浏览器 Web 站骨架。它运行在浏览器里，不是 Electron / Tauri 桌面客户端。

## 开发

```bash
bun run dev:api      # API :3000
bun run dev:web-pc   # PC Web :5174
```

打开 <http://localhost:5174/pc/>。

## 构建

```bash
bun run build:web-pc
```

产物在 `apps/web-pc/dist/`。Vite `base` 是 `/pc/`，TanStack Router `basepath` 是 `/pc`。

## 生产部署

PC Web 与移动端 Web、API 同源部署：

- PC Web：`/pc/`
- 移动端 Web：`/`
- API：`/api/*`
- WebSocket：`/ws/*`

反代需要把无尾斜杠的 `/pc` 规范化到 `/pc/`，并为 `/pc/*` 配 SPA fallback：找不到静态文件时回落到 `/pc/index.html`。Caddy / nginx 的完整示例见 `docs/deployment.md`。

API 请求固定走站点根 `/api`，不会跟随 `/pc/` 前缀，因此同源 Cookie 和 WebSocket 鉴权与移动端一致。
