import { Hono } from 'hono'

/**
 * 品牌静态图（#325）：`apps/web`（移动端 PWA）整体移除后，站点静态根目录不复存在，
 * 但「验证码邮件里的 logo」与「仓库 README 头图」仍然需要一个稳定可访问的绝对地址，
 * 于是改由 API 托管（生产 Caddy 的 `/api/*` 会剥前缀转发到本进程）。
 *
 * 只暴露白名单里的两个文件：路径参数直接来自 URL，白名单是这里唯一的目录穿越防线
 * （把 name 直接拼进 `new URL(name, …)` 时 `../` 会真的跳出 `public/brand/`）。
 */
const BRAND_ASSETS = new Map([
  ['logo.png', 'image/png'],
  ['brand-fish.png', 'image/png'],
])

/** `apps/api/public/brand/`：源码旁的真实路径，Bun 直接按源码位置解析。 */
const BRAND_DIR = new URL('../../../public/brand/', import.meta.url)

export function createBrandAssetsRouter() {
  const router = new Hono()

  router.get('/brand/:name', async (c) => {
    const name = c.req.param('name')
    const contentType = BRAND_ASSETS.get(name)
    if (contentType === undefined) return c.notFound()

    const file = Bun.file(new URL(name, BRAND_DIR))
    // 白名单里的文件名与仓库文件一一对应，取不到只可能是发布时漏同步了 `public/`。
    if (!(await file.exists())) return c.notFound()

    return new Response(file, {
      headers: {
        'Content-Type': contentType,
        // 两个文件名都不带内容哈希，所以只给一天缓存：换图后一天内全网更新完，
        // 又足以让邮件客户端与 GitHub 的图片代理不必每次回源。
        'Cache-Control': 'public, max-age=86400',
      },
    })
  })

  return router
}
