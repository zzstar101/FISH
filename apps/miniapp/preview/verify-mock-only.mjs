/**
 * 校验「哪些页面该发请求、哪些不该发」。
 *
 * 做法：CDP 注入一个 hook，把 fetch / XMLHttpRequest / WebSocket / sendBeacon
 * 全部替换成「记录」的版本，然后逐个路由加载，统计每次加载产生了哪些请求。
 *
 * ## 判定口径（2026-09 起，页面开始接后端）
 *
 * 已接真实接口的页面（首页（含分类筛选）/ 搜索 / 商品详情 / 消息 / 我的 /
 * 许愿（含发布页与匹配结果页）/ 我买到的 / 我卖出的）：允许请求后端，但
 * **只允许发往 `--api` 指定的地址**（默认 `http://localhost:3000`）。发往别处仍算越界。
 * 消息页是「读 + 写」：通知列表（GET /notifications）与切进「通知」tab 的逐条已读
 * 回写（POST /notifications/:id/read）。许愿页是「读 + 写」：GET /wishes、
 * GET /wishes/pool、GET /matches?wishId=、POST /wishes/:id/close；发布页 POST /wishes。
 *
 * 其余页面（出物 / 会话 …）：仍必须**零业务请求** ——
 * 它们的写操作与状态机尚未接接口，一旦偷偷发起请求就说明回退路径被绕过了。
 *
 * 用法：bun preview/verify-mock-only.mjs [--base http://127.0.0.1:4599/index.html] [--api http://localhost:3000]
 */
import { spawn } from 'node:child_process'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
}

const BASE = args.get('base') ?? 'http://127.0.0.1:4599/index.html'
const EDGE = args.get('edge') ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = Number(args.get('port') ?? 9355)
const WIDTH = Number(args.get('width') ?? 375)
const HEIGHT = Number(args.get('height') ?? 812)

/** 与 app.config.ts 的 pages 一致；带参数的路由也各测一次 */
const ROUTES = [
  '/pages/home/index',
  '/pages/wish/index',
  '/pages/wish-publish/index',
  '/pages/match/index',
  '/pages/sell/index',
  '/pages/chat/index',
  '/pages/profile/index',
  '/pages/search/index',
  '/pages/search/index?q=键盘',
  '/pages/listing-detail/index?id=l-001',
  '/pages/listing-detail/index?id=l-014',
  '/pages/conversation/index?id=c-001',
  '/pages/conversation/index?id=c-006',
  '/pages/watchers/index',
  '/pages/orders-buy/index',
  '/pages/orders-sell/index',
]

/**
 * 允许的请求白名单：预览外壳自身要加载 JS/CSS/图片（file 或同源静态资源），
 * 这些不是业务数据请求。只放行 127.0.0.1 上的静态资源与 data:/blob:。
 */
const ALLOW = /^(?:https?:\/\/127\.0\.0\.1:[0-9]+|data:|blob:|file:)/
/** 业务数据请求的特征：静态源里出现这些路径，说明页面绕过了 mock 直连接口 */
const DATA_HINT =
  /\/(api|v1|v2|graphql)\b|localhost:3000|:\d+\/wishes|:\d+\/matches|:\d+\/listings|:\d+\/conversations|:\d+\/notifications|:\d+\/transactions/i

/**
 * 已接真实接口的页面（见 `src/features/fetchers.ts`；消息页经 `features/chat/api.ts`
 * 接了通知列表与逐条已读回写；许愿 / 发布 / 匹配结果页经 `features/wish/api.ts` 与
 * `features/match/api.ts` 接了愿望读写与匹配列表）。这些路由**允许**打后端；
 * 其余路由必须保持零业务请求。
 *
 * 注意：预览 harness 的 `Taro` 桩**没有实现 `request`**，所以这些页在预览里
 * 会因请求失败走到错误态（许愿系页面刻意不回退 mock），`打后端` 一列通常是 0。
 * 其中发布页只在点「发布愿望」时才请求、匹配结果页不带 `wishId` 时直接走
 * 「已结束」分支 —— 本脚本只加载路由、不做交互，所以这两页的数据路径在这里
 * 覆盖不到。本脚本因此校验的是「没有越界请求」，**不能**用来证明真实接口那条
 * 路径可用（那要在微信开发者工具里跑）。
 */
const WIRED = [
  '/pages/home/index',
  '/pages/search/index',
  '/pages/listing-detail/index',
  '/pages/chat/index',
  '/pages/profile/index',
  '/pages/wish/index',
  '/pages/wish-publish/index',
  '/pages/match/index',
  '/pages/orders-buy/index',
  '/pages/orders-sell/index',
]

/** 后端地址：已接接口的页面只允许请求它，发往别处仍算越界 */
const API_ORIGIN = args.get('api') ?? 'http://localhost:3000'

const profile = `${process.env.TEMP ?? '.'}/fish-mockonly-${Date.now()}`
const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 等启动 */
    }
    await sleep(250)
  }
  throw new Error('连不上调试端口')
}

const page = await findPage()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  socket.addEventListener('open', res)
  socket.addEventListener('error', rej)
})

let id = 1
const pending = new Map()
socket.addEventListener('message', (e) => {
  const data = JSON.parse(e.data)
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id)
    pending.delete(data.id)
    if (data.error) reject(new Error(JSON.stringify(data.error)))
    else resolve(data.result)
  }
})
const send = (method, params = {}) => {
  const current = id
  id += 1
  return new Promise((resolve, reject) => {
    pending.set(current, { resolve, reject })
    socket.send(JSON.stringify({ id: current, method, params }))
  })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: true,
})

// 在每次导航前注入 hook（Page.addScriptToEvaluateOnNewDocument 会在文档创建时执行）
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__net = [];
    const rec = (kind, url) => { window.__net.push({ kind, url: String(url) }); };
    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      rec('fetch', url);
      return realFetch.call(this, input, init);
    };
    const RealXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
      const xhr = new RealXHR();
      const open = xhr.open;
      xhr.open = function (method, url) { rec('xhr', url); return open.apply(xhr, arguments); };
      return xhr;
    };
    const RealWS = window.WebSocket;
    window.WebSocket = function (url) { rec('ws', url); return new RealWS(url); };
    if (navigator.sendBeacon) {
      const sb = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) { rec('beacon', url); return sb(url, data); };
    }
  `,
})

let failures = 0
const rows = []

for (const route of ROUTES) {
  await send('Runtime.evaluate', { expression: 'window.__net = []' }).catch(() => undefined)
  await send('Page.navigate', { url: `${BASE}#${route}` })
  await sleep(1800)
  const result = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__net || [])',
    returnByValue: true,
  })
  const net = JSON.parse(result.result.value ?? '[]')
  // 路由带 query（`?q=…&id=…`）时只按 pathname 判定它属不属于已接接口的那一页
  const path = route.split('?')[0] ?? route
  const isWired = WIRED.includes(path)
  const offenders = net.filter((n) => {
    // 已接接口的页面打后端是预期行为，但只放行配置的 API 地址
    if (isWired && n.url.startsWith(API_ORIGIN)) return false
    // 预览外壳自身的静态资源
    if (!ALLOW.test(n.url)) return true
    // 静态源里冒出业务路径 = 绕过 mock 直连接口
    return DATA_HINT.test(n.url)
  })
  const apiCalls = net.filter((n) => n.url.startsWith(API_ORIGIN)).length
  rows.push({ route, total: net.length, offenders, apiCalls, isWired })
  if (offenders.length > 0) failures += 1
}

console.log('路由'.padEnd(42), '请求数', ' 打后端', '  预期外的请求')
for (const row of rows) {
  console.log(
    row.route.padEnd(42),
    String(row.total).padStart(5),
    String(row.apiCalls).padStart(6),
    ' ',
    row.offenders.length === 0
      ? row.isWired
        ? '0 ✓ (已接接口)'
        : '0 ✓ (未接接口，应保持)'
      : `${row.offenders.length} ✗  ${row.offenders.map((o) => `${o.kind} ${o.url}`).join(', ')}`,
  )
}

socket.close()
child.kill()

if (failures > 0) {
  console.log(
    `\n✗ ${failures} 个路由出现了预期外的请求 —— 未接接口的页面不该发业务请求，` +
      `已接接口的页面也只允许请求 ${API_ORIGIN}`,
  )
  process.exit(1)
}
console.log(
  `\n✓ 未接接口的页面零业务请求；已接接口的页面只请求 ${API_ORIGIN}（已接接口页：${WIRED.length} 个，含消息页的通知已读回写）`,
)
process.exit(0)
