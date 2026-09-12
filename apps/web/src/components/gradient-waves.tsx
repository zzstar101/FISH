import { Mesh, Program, Renderer, Triangle } from 'ogl'
import { useEffect, useRef } from 'react'
import './gradient-waves.css'

/**
 * React Bits 的 `GradientWaves`（TypeScript + CSS 变体），来源组件原样移植。
 *
 * 相对上游源码只做了本项目必需的改动：
 * - 去掉 `any`（`tsconfig.base.json` 禁止）+ 适配 `noUncheckedIndexedAccess`；
 * - 组件改为具名函数导出，不引入 React 默认导入（`verbatimModuleSyntax`）。
 * shader 与 uniform 语义与上游逐字一致。
 */

export type GradientWavesDetail = 'low' | 'medium' | 'high'

export type GradientWavesProps = {
  horizonColor?: string
  waveColor?: string
  crestColor?: string
  speed?: number
  amplitude?: number
  waveScale?: number
  waveRatio?: number
  swell?: number
  turbulence?: number
  tilt?: number
  zoom?: number
  height?: number
  fogDepth?: number
  detail?: GradientWavesDetail
  brightness?: number
  opacity?: number
  mouseInteraction?: boolean
  parallaxStrength?: number
  grain?: boolean
  grainIntensity?: number
  className?: string
}

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return [1, 1, 1]
  return [
    Number.parseInt(result[1] ?? 'ff', 16) / 255,
    Number.parseInt(result[2] ?? 'ff', 16) / 255,
    Number.parseInt(result[3] ?? 'ff', 16) / 255,
  ]
}

function detailToSteps(detail: GradientWavesDetail): number {
  if (detail === 'low') return 40.0
  if (detail === 'high') return 110.0
  return 70.0
}

const vertex = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const fragment = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaveScale;
uniform float uWaveRatio;
uniform float uSwell;
uniform float uTurbulence;
uniform float uTilt;
uniform float uZoom;
uniform float uHeight;
uniform float uFogDepth;
uniform float uSteps;
uniform float uBrightness;
uniform float uOpacity;
uniform float uGrain;
uniform float uGrainIntensity;
uniform vec2 uMouse;
uniform float uParallax;
uniform bool uEnableMouse;
uniform vec3 uHorizonColor;
uniform vec3 uWaveColor;
uniform vec3 uCrestColor;
out vec4 fragColor;

const float MAX_DIST = 20000.0;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float plasma(vec3 r, vec2 freq, vec4 tc) {
  float mx = r.x + tc.x;
  mx += uSwell * sin((r.y + mx) / 20.0 + tc.y);
  float my = r.y - tc.z;
  my += uTurbulence * cos(r.x / 23.0 + tc.w);
  return r.z - (sin(mx * freq.x) * uAmplitude + sin(my * freq.y) * uAmplitude + uHeight);
}

float raymarch(vec3 pos, vec3 dir, vec2 freq, vec4 tc) {
  float dist = 0.0;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= uSteps) break;
    float dscene = plasma(pos + dist * dir, freq, tc);
    if (abs(dscene) < 0.1) break;
    dist += 0.9 * dscene;
    if (!(abs(dist) < MAX_DIST)) return MAX_DIST;
  }
  return dist;
}

void main() {
  float T = iTime * uSpeed;
  vec2 freq = vec2(uWaveScale / 7.0, (uWaveScale * uWaveRatio) / 3.0);
  vec4 tc = vec4(T / 0.130, T / 0.810, T / 0.200, T / 0.710);
  float c, s;
  float vfov = (3.14159 / 2.3) / max(uZoom, 0.05);
  vec3 cam = vec3(0.0, 0.0, 30.0);
  vec2 uv = (gl_FragCoord.xy / iResolution.xy) - 0.5;
  uv.x *= iResolution.x / iResolution.y;
  uv.y *= -1.0;

  vec3 dir = vec3(0.0, 0.0, -1.0);
  float ulen = length(uv);
  float xrot = vfov * ulen;
  c = cos(xrot); s = sin(xrot);
  dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  vec2 nuv = ulen > 1e-5 ? uv / ulen : vec2(1.0, 0.0);
  c = nuv.x; s = nuv.y;
  dir = mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0) * dir;
  c = cos(uTilt); s = sin(uTilt);
  dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;

  if (uEnableMouse) {
    float yaw = (uMouse.x - 0.5) * uParallax * 0.4;
    float pitch = (uMouse.y - 0.5) * uParallax * 0.4;
    c = cos(yaw); s = sin(yaw);
    dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;
    c = cos(pitch); s = sin(pitch);
    dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  }

  float dist = raymarch(cam, dir, freq, tc);
  vec3 pos = cam + dist * dir;

  float t = clamp(uFogDepth / max(dist, 0.001), 0.0, 1.0);
  vec3 body = mix(uWaveColor, uCrestColor, clamp(pos.z * 0.08 + 0.5, 0.0, 1.0));
  vec3 col = mix(uHorizonColor, body, t);
  col *= uBrightness;
  col = clamp(col, 0.0, 1.0);

  float alpha = clamp(t, 0.0, 1.0) * uOpacity;
  if (uGrain > 0.5) {
    float g = hash21(gl_FragCoord.xy + mod(iTime, 64.0) * 11.0);
    alpha += (g - 0.5) * uGrainIntensity;
  }
  alpha = clamp(alpha, 0.0, 1.0);
  fragColor = vec4(col * alpha, alpha);
}
`

type GradientWavesCtx = {
  renderer: Renderer
  program: Program
  mesh: Mesh
}
const ctxMap = new WeakMap<HTMLDivElement, GradientWavesCtx>()

/**
 * ogl 把 uniform 值暴露为 `any`。这里收窄成实际会写入的三种类型，
 * 让本文件自身不出现 `any`（读写都只走下面这三个 helper）。
 */
type UniformSlot = { value: number | boolean | Float32Array }

function uniformSlot(program: Program, name: string): UniformSlot | undefined {
  return program.uniforms[name] as UniformSlot | undefined
}

function setNumber(program: Program, name: string, value: number): void {
  const slot = uniformSlot(program, name)
  if (slot) slot.value = value
}

function setFloat3(program: Program, name: string, rgb: [number, number, number]): void {
  const slot = uniformSlot(program, name)
  if (slot?.value instanceof Float32Array) {
    slot.value[0] = rgb[0]
    slot.value[1] = rgb[1]
    slot.value[2] = rgb[2]
  }
}

function setVector2(program: Program, name: string, x: number, y: number): void {
  const slot = uniformSlot(program, name)
  if (slot?.value instanceof Float32Array) {
    slot.value[0] = x
    slot.value[1] = y
  }
}

export function GradientWaves({
  horizonColor = '#5227FF',
  waveColor = '#FF9FFC',
  crestColor = '#FFFFFF',
  speed = 0.4,
  amplitude = 2.5,
  waveScale = 0.6,
  waveRatio = 0.9,
  swell = 35,
  turbulence = 20,
  tilt = 1.11,
  zoom = 1.0,
  height = 5.5,
  fogDepth = 15,
  detail = 'medium',
  brightness = 1.0,
  opacity = 1.0,
  mouseInteraction = true,
  parallaxStrength = 0.5,
  grain = true,
  grainIntensity = 0.05,
  className = '',
}: GradientWavesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const enableMouseRef = useRef<boolean>(mouseInteraction)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new Renderer({
      webgl: 2,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      dpr: Math.min(window.devicePixelRatio || 1, 2),
    })

    const gl = renderer.gl
    gl.clearColor(0, 0, 0, 0)
    const canvas = gl.canvas as HTMLCanvasElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    container.appendChild(canvas)

    const geometry = new Triangle(gl)
    const program = new Program(gl, {
      vertex,
      fragment,
      uniforms: {
        iTime: { value: 0 },
        iResolution: { value: new Float32Array([1, 1]) },
        uSpeed: { value: 0.4 },
        uAmplitude: { value: 2.5 },
        uWaveScale: { value: 0.6 },
        uWaveRatio: { value: 0.9 },
        uSwell: { value: 35 },
        uTurbulence: { value: 20 },
        uTilt: { value: 1.11 },
        uZoom: { value: 1.0 },
        uHeight: { value: 5.5 },
        uFogDepth: { value: 15 },
        uSteps: { value: 70.0 },
        uBrightness: { value: 1.0 },
        uOpacity: { value: 1.0 },
        uGrain: { value: 1.0 },
        uGrainIntensity: { value: 0.05 },
        uMouse: { value: new Float32Array([0.5, 0.5]) },
        uParallax: { value: 0.5 },
        uEnableMouse: { value: true },
        uHorizonColor: { value: new Float32Array([1, 1, 1]) },
        uWaveColor: { value: new Float32Array([1, 1, 1]) },
        uCrestColor: { value: new Float32Array([1, 1, 1]) },
      },
    })

    const mesh = new Mesh(gl, { geometry, program })
    ctxMap.set(container, { renderer, program, mesh })

    const setSize = () => {
      const rect = container.getBoundingClientRect()
      const w = Math.max(1, Math.floor(rect.width))
      const h = Math.max(1, Math.floor(rect.height))
      renderer.setSize(w, h)
      setVector2(program, 'iResolution', gl.drawingBufferWidth, gl.drawingBufferHeight)
      renderer.render({ scene: mesh })
    }

    const ro = new ResizeObserver(setSize)
    ro.observe(container)
    setSize()

    const currentMouse: [number, number] = [0.5, 0.5]
    const targetMouse: [number, number] = [0.5, 0.5]

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      targetMouse[0] = (event.clientX - rect.left) / rect.width
      targetMouse[1] = 1.0 - (event.clientY - rect.top) / rect.height
    }
    const onPointerLeave = () => {
      targetMouse[0] = 0.5
      targetMouse[1] = 0.5
    }
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)

    let raf = 0
    let isVisible = true
    let isPageVisible = !document.hidden
    const t0 = performance.now()

    const loop = (t: number) => {
      setNumber(program, 'iTime', (t - t0) * 0.001)
      const tx = enableMouseRef.current ? targetMouse[0] : 0.5
      const ty = enableMouseRef.current ? targetMouse[1] : 0.5
      currentMouse[0] += 0.05 * (tx - currentMouse[0])
      currentMouse[1] += 0.05 * (ty - currentMouse[1])
      setVector2(program, 'uMouse', currentMouse[0], currentMouse[1])
      renderer.render({ scene: mesh })
      raf = requestAnimationFrame(loop)
    }

    const tryStart = () => {
      if (isVisible && isPageVisible && raf === 0) raf = requestAnimationFrame(loop)
    }
    const tryStop = () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    const io = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      isVisible = entry.isIntersecting
      if (isVisible) tryStart()
      else tryStop()
    })
    io.observe(container)

    const onVisibility = () => {
      isPageVisible = !document.hidden
      if (isPageVisible) tryStart()
      else tryStop()
    }
    document.addEventListener('visibilitychange', onVisibility)

    tryStart()

    return () => {
      tryStop()
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      ctxMap.delete(container)
      try {
        container.removeChild(canvas)
      } catch {
        // 容器可能已随组件卸载被移除，此时无需再清理 canvas 节点。
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ctx = ctxMap.get(container)
    if (!ctx) return
    const { program } = ctx

    enableMouseRef.current = mouseInteraction

    setNumber(program, 'uSpeed', speed)
    setNumber(program, 'uAmplitude', amplitude)
    setNumber(program, 'uWaveScale', waveScale)
    setNumber(program, 'uWaveRatio', waveRatio)
    setNumber(program, 'uSwell', swell)
    setNumber(program, 'uTurbulence', turbulence)
    setNumber(program, 'uTilt', tilt)
    setNumber(program, 'uZoom', zoom)
    setNumber(program, 'uHeight', height)
    setNumber(program, 'uFogDepth', fogDepth)
    setNumber(program, 'uSteps', detailToSteps(detail))
    setNumber(program, 'uBrightness', brightness)
    setNumber(program, 'uOpacity', opacity)
    setNumber(program, 'uGrain', grain ? 1.0 : 0.0)
    setNumber(program, 'uGrainIntensity', grainIntensity)
    setNumber(program, 'uParallax', parallaxStrength)
    setNumber(program, 'uEnableMouse', mouseInteraction ? 1 : 0)
    setFloat3(program, 'uHorizonColor', hexToRgb(horizonColor))
    setFloat3(program, 'uWaveColor', hexToRgb(waveColor))
    setFloat3(program, 'uCrestColor', hexToRgb(crestColor))
  }, [
    horizonColor,
    waveColor,
    crestColor,
    speed,
    amplitude,
    waveScale,
    waveRatio,
    swell,
    turbulence,
    tilt,
    zoom,
    height,
    fogDepth,
    detail,
    brightness,
    opacity,
    grain,
    grainIntensity,
    mouseInteraction,
    parallaxStrength,
  ])

  return <div className={`gradient-waves-container ${className}`.trim()} ref={containerRef} />
}

export default GradientWaves
