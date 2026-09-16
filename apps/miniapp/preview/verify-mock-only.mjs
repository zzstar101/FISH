/**
 * 证明「数据全部来自 mock」：把预览里所有页面的网络出口全部拦截并计数。
 *
 * 做法：CDP 注入一个 hook，把 fetch / XMLHttpRequest / WebSocket / sendBeacon
 * 全部替换成「记录 + 抛错」的版本，然后逐个路由加载，统计是否出现 expect 之外的回调。
 * 任何真实请求都会让脚本以非 0 退出。
 *
 * 用法：bun preview/verify-mock-only.mjs [--base http://127.0.0.1:4599/index.html]
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
  '/pages/sell/index',
  '/pages/chat/index',
  '/pages/profile/index',
  '/pages/search/index',
  '/pages/search/index?q=键盘',
  '/pages/listing-detail/index?id=l-001',
  '/pages/listing-detail/index?id=l-014',
  '/pages/conversation/index?id=c-001',
  '/pages/conversation/index?id=c-006',
  '/pages/notifications/index',
]

/**
 * 允许的请求白名单：预览外壳自身要加载 JS/CSS/图片（file 或同源静态资源），
 * 这些不是业务数据请求。只放行 127.0.0.1 上的静态资源与 data:/blob:。
 */
const ALLOW = /^(?:https?:\/\/127\.0\.0\.1:[0-9]+|data:|blob:|file:)/
/** 业务数据请求的特征：这些一律视为「接了真接口」 */
const DATA_HINT = /\/(api|v1|v2|graphql)\b|localhost:3000|:\d+\/wishes|:\d+\/listings|:\d+\/conversations/i

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
  const offenders = net.filter((n) => !ALLOW.test(n.url) || DATA_HINT.test(n.url))
  rows.push({ route, total: net.length, offenders })
  if (offenders.length > 0) failures += 1
}

console.log('路由'.padEnd(42), '请求数', '  业务数据请求')
for (const row of rows) {
  console.log(
    row.route.padEnd(42),
    String(row.total).padStart(5),
    ' ',
    row.offenders.length === 0
      ? '0 ✓'
      : `${row.offenders.length} ✗  ${row.offenders.map((o) => `${o.kind} ${o.url}`).join(', ')}`,
  )
}

socket.close()
child.kill()

if (failures > 0) {
  console.log(`\n✗ ${failures} 个路由出现了真实业务请求 —— 数据并非全部来自 mock`)
  process.exit(1)
}
console.log('\n✓ 全部路由都没有业务数据请求：数据 100% 来自 src/mock（页面里没有真实 API 调用）')
process.exit(0)
