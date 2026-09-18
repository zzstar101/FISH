/**
 * 用 Edge 的 headless 模式给预览页截图（可多路由、可测量 DOM）。
 *
 * 为什么不用 `msedge --screenshot`：那个开关只截「首屏」，长页面会被裁掉，
 * 而且拿不到任何 DOM 数值。这里直连 CDP：Page.captureScreenshot + Runtime.evaluate，
 * 既能截全页，也能顺手把关键元素的实际盒子量回来（视觉问题靠猜最费时间）。
 *
 * 用法：
 *   node preview/shoot.mjs --route /pages/home/index --out D:/FISH/_shots/home.png
 *   node preview/shoot.mjs --route /pages/listing-detail/index?id=l-001 --measure .pcard,.tabbar
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
}

const BASE = args.get('base') ?? 'http://127.0.0.1:4599/index.html'
const ROUTE = args.get('route') ?? '/pages/home/index'
const OUT = args.get('out') ?? 'D:/FISH/_shots/shot.png'
const WIDTH = Number(args.get('width') ?? 390)
const HEIGHT = Number(args.get('height') ?? 844)
const SCALE = Number(args.get('scale') ?? 2)
const MEASURE = args.get('measure') ?? ''
const FULL = args.get('full') !== 'false'

const EDGE = args.get('edge') ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = Number(args.get('port') ?? 9333)

const { spawn } = await import('node:child_process')

const profile = `${process.env.TEMP ?? '.'}/fish-shot-${Date.now()}`
const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `about:blank`,
  ],
  { stdio: 'ignore', detached: false },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function targets() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 还没起来
    }
    await sleep(250)
  }
  throw new Error('连不上 Edge 的调试端口')
}

const page = await targets()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data)
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id)
    pending.delete(data.id)
    if (data.error) reject(new Error(JSON.stringify(data.error)))
    else resolve(data.result)
  }
})

function send(method, params = {}) {
  const id = nextId
  nextId += 1
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: SCALE,
  mobile: true,
})

const url = `${BASE}#${ROUTE}`
await send('Page.navigate', { url })
await sleep(Number(args.get('wait') ?? 2500))

if (MEASURE) {
  const selectors = MEASURE.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const script = `
    (() => {
      const out = { viewport: { w: window.innerWidth, h: window.innerHeight },
                    scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight } };
      const sels = ${JSON.stringify(selectors)};
      const describe = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(), cls: el.className,
          x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
          fontSize: cs.fontSize, color: cs.color, background: cs.backgroundColor,
          borderRadius: cs.borderRadius, overflowX: cs.overflowX,
          flex: cs.flex, minWidth: cs.minWidth, display: cs.display,
          scrollW: el.scrollWidth, alignSelf: cs.alignSelf, marginTop: cs.marginTop,
        };
      };
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) { out[sel] = null; continue; }
        out[sel] = describe(el);
        // 祖先链宽度：定位「谁把宽度挤压了」
        const chain = [];
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i += 1) { chain.push(describe(p)); p = p.parentElement; }
        out[sel + '::ancestors'] = chain;
      }
      return JSON.stringify(out);
    })()
  `
  const result = await send('Runtime.evaluate', { expression: script, returnByValue: true })
  console.log('MEASURE', result.result.value)
}

const screenshotParams = { format: 'png', captureBeyondViewport: FULL }
if (FULL) {
  const metrics = await send('Page.getLayoutMetrics')
  const size = metrics.cssContentSize ?? metrics.contentSize
  screenshotParams.clip = {
    x: 0,
    y: 0,
    width: WIDTH,
    height: Math.min(size.height, 6000),
    scale: 1,
  }
}

const shot = await send('Page.captureScreenshot', screenshotParams)
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
console.log('SHOT', OUT)

socket.close()
child.kill()
process.exit(0)
