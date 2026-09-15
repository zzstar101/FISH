import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { Camera, ScanLine } from 'lucide-react'
import type { FormEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

export type ScanResult = { rawValue: string }

export function normalizeScanResult(rawValue: string): ScanResult | null {
  const value = rawValue.trim()
  return value ? { rawValue: value } : null
}

type Barcode = { rawValue: string }
type BarcodeDetectorLike = {
  detect: (source: ImageBitmapSource) => Promise<Barcode[]>
}
type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike

type ScannerStatus =
  | 'idle'
  | 'starting'
  | 'scanning'
  | 'unsupported'
  | 'permission-denied'
  | 'error'

function barcodeDetectorConstructor(): BarcodeDetectorConstructor | null {
  const candidate = (globalThis as typeof globalThis & { BarcodeDetector?: unknown })
    .BarcodeDetector
  return typeof candidate === 'function' ? (candidate as BarcodeDetectorConstructor) : null
}

/**
 * 业务无关的 Web 扫码面板（#69）。成功时只返回扫码器给出的原始字符串，
 * 不解析 transactionId、URL 或任何业务字段；交易域由调用方决定如何消费 rawValue。
 */
export function ScannerPanel({ onScan }: { onScan: (result: ScanResult) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<number | null>(null)
  const [status, setStatus] = useState<ScannerStatus>('idle')
  const [manualValue, setManualValue] = useState('')
  const [manualError, setManualError] = useState('')

  const stopCamera = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  useEffect(() => stopCamera, [stopCamera])

  const startCamera = async () => {
    setManualError('')
    const Detector = barcodeDetectorConstructor()
    if (!Detector) {
      setStatus('unsupported')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported')
      return
    }

    stopCamera()
    setStatus('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      })
      streamRef.current = stream
      const video = videoRef.current
      if (!video) {
        stopCamera()
        setStatus('error')
        return
      }
      video.srcObject = stream
      await video.play()
      setStatus('scanning')

      const detector = new Detector({ formats: ['qr_code'] })
      const scanFrame = async () => {
        if (!videoRef.current || videoRef.current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          frameRef.current = requestAnimationFrame(() => void scanFrame())
          return
        }
        try {
          const results = await detector.detect(videoRef.current)
          const result = results
            .map((item) => normalizeScanResult(item.rawValue))
            .find((item): item is ScanResult => item !== null)
          if (result) {
            stopCamera()
            setStatus('idle')
            onScan(result)
            return
          }
        } catch {
          stopCamera()
          setStatus('error')
          return
        }
        frameRef.current = requestAnimationFrame(() => void scanFrame())
      }
      frameRef.current = requestAnimationFrame(() => void scanFrame())
    } catch (error) {
      stopCamera()
      setStatus(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'permission-denied'
          : 'error',
      )
    }
  }

  const submitManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const result = normalizeScanResult(manualValue)
    if (!result) {
      setManualError('请输入二维码内容')
      return
    }
    setManualError('')
    onScan(result)
  }

  const statusMessage = {
    idle: '将二维码放入取景框内',
    starting: '正在打开摄像头…',
    scanning: '正在识别二维码…',
    unsupported: '当前浏览器不支持摄像头扫码，请手动输入',
    'permission-denied': '没有摄像头权限，请在浏览器设置中允许访问，或手动输入',
    error: '摄像头启动失败，请重试或手动输入',
  }[status]

  return (
    <section aria-label="扫码" className="space-y-4 rounded-2xl bg-surface p-4">
      <div className="relative aspect-square overflow-hidden rounded-2xl bg-ink">
        <video
          aria-label="二维码取景器"
          className={`size-full object-cover ${status === 'scanning' || status === 'starting' ? '' : 'hidden'}`}
          muted
          playsInline
          ref={videoRef}
        />
        {status !== 'scanning' && status !== 'starting' ? (
          <div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center text-white">
            <ScanLine className="size-12 opacity-80" />
            <p className="text-sm">{statusMessage}</p>
          </div>
        ) : null}
        {status === 'scanning' ? (
          <div className="pointer-events-none absolute inset-10 rounded-2xl border-2 border-white/80" />
        ) : null}
      </div>

      <p aria-live="polite" className="text-center text-ink-2 text-sm">
        {statusMessage}
      </p>

      <Button
        className="w-full"
        disabled={status === 'starting' || status === 'scanning'}
        onClick={() => void startCamera()}
      >
        <Camera className="size-4" />
        {status === 'scanning' ? '扫码中' : '打开摄像头扫码'}
      </Button>

      <div className="flex items-center gap-3 text-ink-3 text-xs">
        <span className="h-px flex-1 bg-line" />
        或手动输入
        <span className="h-px flex-1 bg-line" />
      </div>

      <form className="space-y-2" onSubmit={submitManual}>
        <Input
          aria-label="扫码内容"
          autoCapitalize="none"
          autoComplete="off"
          onChange={(event) => setManualValue(event.target.value)}
          placeholder="输入扫码结果"
          value={manualValue}
        />
        {manualError ? <p className="text-danger text-xs">{manualError}</p> : null}
        <Button className="w-full" type="submit" variant="outline">
          提交扫码内容
        </Button>
      </form>
    </section>
  )
}
