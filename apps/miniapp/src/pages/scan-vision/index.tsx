import { Camera, Canvas, Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo, useRef, useState } from 'react'
import ScanTabs from '@/components/scan-tabs'
import type { PickedPhoto } from '@/features/upload/api'
import { pickPhotoOfSource, readFileSize } from '@/features/upload/api'
import { visualSearchErrorMessage } from '@/features/visual-search/api'
import {
  type CropHandle,
  centeredBox,
  cropHandleAt,
  cropOutputSize,
  dragCropBox,
  MAX_CROP_OUTPUT,
  type Point,
  type Rect,
  toImageRect,
} from '@/features/visual-search/crop'
import { stashVisualShot } from '@/features/visual-search/handoff'
import { submitVisualQuery } from '@/features/visual-search/start'
import { backButtonGeometry, readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 识图（拍照找同款）—— 扫码家族第三段 tab 的落点页。
 *
 * 取图与取框（Owner 2026-09-29 按两张参考图定版）：
 *
 * ```text
 * 取景态：<Camera mode="normal"> 全屏预览 + 页面自绘取景框（500×520rpx，与另外两页同一套）
 *         底部一排：相册 · 快门 · 聊天记录（微信原生只留后两个来源，拍摄由本页自己开相机）
 *     ↓ 按下快门（CameraContext.takePhoto）
 * 取框态：**图片冻结**铺满屏，取景框原位换成可拖拽的取选框
 *         拖四角 / 四边放大、拖框内移动 → 「搜索」把框内裁出来上传
 * ```
 *
 * **为什么不像另外两页那样挂 `mode="scanCode"`**：识图要的是「拍一张商品照」，不是连续
 * 识别；`mode="normal"` 才允许 `takePhoto`。
 *
 * **为什么取框态要重画一次裁切**：`takePhoto` 给的是**整张**照片，而检索只该拿商品那一块
 * （参考图 ② 就是「整张照片 + 框住鼠标」）。裁剪用离屏 `<Canvas>` 的 `drawImage` 源矩形 +
 * `canvasToTempFilePath`，几何全在 `features/visual-search/crop.ts`（纯逻辑、有单测）。
 *
 * **相机不可用不再弹窗**（Owner 2026-09-29）：权限被拒 / 无相机只把取景层换成一句提示，
 * 底部三个来源与扫码家族切换钮照常可用 —— 弹窗会挡住用户换来源，而换来源正是他此刻要做的事。
 */
export default function ScanVision() {
  /** `viewfinder` = 相机取景；`adjust` = 照片冻结、调整取选框 */
  const [phase, setPhase] = useState<'viewfinder' | 'adjust'>('viewfinder')
  /** 上传在途：底部按钮防连点（原生面板是模态的，上传腿不是） */
  const [busy, setBusy] = useState(false)
  /** 相机是否可用（不可用时只出提示，不阻断操作） */
  const [cameraOn, setCameraOn] = useState(true)
  /** 相机实例序号：作为 key，换号即整体重挂（报错恢复 / 回前台防预览冻结） */
  const [cameraEpoch, setCameraEpoch] = useState(0)

  /** 冻结的照片：本地路径 + 原图像素尺寸（裁剪几何要用真尺寸反算） */
  const [shot, setShot] = useState<{ path: string; width: number; height: number } | null>(null)
  /** 取选框（**显示坐标**，非图片像素） */
  const [box, setBox] = useState<Rect | null>(null)
  /** 取景层 / 取图层的设备 px 尺寸（`boundingClientRect` 量出来） */
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null)

  /** 本次拖动的目标手柄与上一次触点（触点必须记 ref：`onTouchMove` 一帧多次，状态来不及） */
  const dragRef = useRef<{ handle: CropHandle; point: Point } | null>(null)

  // 返回钮与标题的垂直位置跟微信原生胶囊对齐（设备 px，内联下发，不参与 rpx 缩放）
  const nav = useMemo(() => readNavMetrics(), [])
  const backGeo = backButtonGeometry(nav.capsuleHeight)

  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) void Taro.navigateBack()
    else void Taro.switchTab({ url: '/pages/home/index' })
  }

  /** 量取景层 / 取图层的真实像素尺寸（取框几何与触摸坐标都在这个坐标系里）。 */
  const measureStage = (selector: string): Promise<{ width: number; height: number } | null> =>
    new Promise((resolve) => {
      Taro.createSelectorQuery()
        .select(selector)
        .boundingClientRect()
        .exec((res) => {
          const rect = res?.[0] as { width?: number; height?: number } | undefined
          if (!rect?.width || !rect.height) {
            resolve(null)
            return
          }
          resolve({ width: rect.width, height: rect.height })
        })
    })

  /** 取景框的**设备 px** 尺寸：设计值 500×520rpx，rpx 只按屏宽缩放（750rpx = 屏宽）。 */
  const frameSize = (): { width: number; height: number } => {
    const ratio = Taro.getWindowInfo().windowWidth / 750
    return { width: Math.round(500 * ratio), height: Math.round(520 * ratio) }
  }

  /**
   * 快门：`takePhoto` 拿到整张照片 → 读真实像素 → 把取景框原位换成取选框。
   *
   * `takePhoto` 只给路径不给尺寸，所以要多走一次 `getImageInfo` —— 少了它就没法把
   * 显示坐标换算成裁剪用的图片像素。
   */
  const shoot = async () => {
    if (busy) return
    setBusy(true)
    try {
      const photo = await new Promise<string>((resolve, reject) => {
        Taro.createCameraContext().takePhoto({
          quality: 'high',
          success: (res) => resolve(res.tempImagePath),
          fail: (res) => reject(new Error(res.errMsg || '拍摄失败')),
        })
      })

      const info = await Taro.getImageInfo({ src: photo })
      const size = await measureStage('.scanvis__stage')
      const view = size ?? { width: info.width, height: info.height }

      setShot({ path: photo, width: info.width, height: info.height })
      // 取选框与取景框同尺寸同中心：用户对准的范围就是他按下快门后看到的那个框
      setBox(centeredBox(view, frameSize()))
      setStage(view)
      setPhase('adjust')
    } catch (error) {
      // 拍失败不弹阻断弹窗（Owner 2026-09-29）：一句 toast，用户自己决定重试还是换来源
      void Taro.showToast({
        title: error instanceof Error && error.message ? '拍摄失败，请重试' : '拍摄失败，请重试',
        icon: 'none',
      })
    } finally {
      setBusy(false)
    }
  }

  /** 取框态：回到取景（照片丢掉，不做缓存 —— 这次识别已经不需要它了） */
  const retake = () => {
    setShot(null)
    setBox(null)
    setPhase('viewfinder')
    // 换 key 重挂相机：`mode="normal"` 的相机在 hide→show 后部分机型预览会冻结
    setCameraEpoch((n) => n + 1)
  }

  /**
   * 裁剪 + 上传 + 跳结果页。
   *
   * 裁剪几何走 `toImageRect`（显示坐标 → 图片像素），输出长边由 `cropOutputSize` 收到
   * `MAX_CROP_OUTPUT` 以内 —— 查询图有 5MB 上限，而「框住整屏」时裁出来的原图可能远超它。
   */
  const confirmCrop = async () => {
    if (busy || !shot || !box || !stage) return
    setBusy(true)
    try {
      const source = toImageRect(box, stage, shot)
      const output = cropOutputSize({ width: source.w, height: source.h })
      const croppedPath = await cropImage(shot.path, source, output)
      /*
        先把「原图 + 取框」交给结果页（共享元素式切换：结果页的背景仍是这张原图，并在上面
        标出这次用的是哪一块）。必须在跳转**之前** stash —— 跳转后本页的 state 就没人读了。
        搜索页 / 结果页的「换图」没有相机、不会 stash，结果页据此退回「只显示查询图」。
      */
      stashVisualShot({ path: shot.path, width: shot.width, height: shot.height, crop: source }) // 裁剪输出的字节数由文件系统读（`takePhoto` / 画布都不给 size）；读不到就是 0，
      // 上传前服务端还会按真实字节复核，本地这个数只用于预检文案
      const photo: PickedPhoto = {
        path: croppedPath,
        // 裁剪输出固定走 jpg（`canvasToTempFilePath` 的 fileType），与声明一致
        mime: 'image/jpeg',
        sizeBytes: readFileSize(croppedPath),
      }
      await submitVisualQuery(photo)
    } catch (error) {
      void Taro.showToast({ title: visualSearchErrorMessage(error), icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  /** 从相册 / 聊天记录取图：没有相机参与，取到的就是成品图，直接上传。 */
  const pickFrom = async (source: 'album' | 'chat') => {
    if (busy) return
    setBusy(true)
    try {
      const { photos, rejected } = await pickPhotoOfSource(source)
      if (photos.length === 0) {
        if (rejected !== null) void Taro.showToast({ title: rejected, icon: 'none' })
        return
      }
      const photo = photos[0]
      if (photo === undefined) return
      await submitVisualQuery(photo)
    } catch (error) {
      void Taro.showToast({ title: visualSearchErrorMessage(error), icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  /* ------------------------------------------------- 取框态的手势（触摸 → 几何） */

  /**
   * 触摸点的 `clientX/clientY`。
   *
   * 形参取 `unknown` 再按运行时形状收窄：`View.d.ts` 把四个触摸回调都声明成
   * `CommonEventFunction`（形参 `BaseEventOrig<any>`，**没有** `touches`），直接声明成带
   * `touches` 的类型会参数不兼容（TS 对回调参数按逆变检查）。运行时事件里当然有 `touches`。
   */
  const touchPoint = (event: unknown): Point | null => {
    const touches = (event as { touches?: { clientX?: number; clientY?: number }[] } | null)
      ?.touches
    const touch = touches?.[0]
    if (!touch || touch.clientX === undefined || touch.clientY === undefined) return null
    return { x: touch.clientX, y: touch.clientY }
  }

  const onBoxTouchStart = (event: unknown) => {
    if (!box || !stage) return
    const point = touchPoint(event)
    if (!point) return
    const handle = cropHandleAt(box, point)
    if (!handle) return
    dragRef.current = { handle, point }
  }

  const onBoxTouchMove = (event: unknown) => {
    const drag = dragRef.current
    if (!drag || !box || !stage) return
    const point = touchPoint(event)
    if (!point) return
    const delta = { x: point.x - drag.point.x, y: point.y - drag.point.y }
    dragRef.current = { handle: drag.handle, point }
    setBox(dragCropBox(box, drag.handle, delta, stage))
  }

  const onBoxTouchEnd = () => {
    dragRef.current = null
  }

  const corner = (key: 'tl' | 'tr' | 'bl' | 'br') => (
    <View className={`scanvis__handle scanvis__handle--${key}`} />
  )

  return (
    <View className="scanvis">
      {/* ---------------- 取景底：取景态是相机，取框态是冻结的照片 ---------------- */}
      <View className="scanvis__stage">
        {phase === 'viewfinder' ? (
          cameraOn ? (
            <Camera
              key={cameraEpoch}
              className="scanvis__camera"
              mode="normal"
              devicePosition="back"
              flash="off"
              onError={() => setCameraOn(false)}
              onStop={() => setCameraEpoch((n) => n + 1)}
            />
          ) : (
            // 相机不可用：不弹窗（会挡住换来源），只把取景层换成一句说明
            <View className="scanvis__noCam">
              <Text className="scanvis__noCam-title">相机不可用</Text>
              <Text className="scanvis__noCam-text">可以改用下面的「相册」或「聊天记录」</Text>
            </View>
          )
        ) : shot ? (
          <Image className="scanvis__shot" src={shot.path} mode="aspectFill" />
        ) : null}
      </View>
      {/* ---------------- 取景框（取景态）/ 取选框（取框态） ---------------- */}
      {phase === 'viewfinder' ? (
        <View className="scanvis__frame">
          <View className="scanvis__cnr scanvis__cnr--tl" />
          <View className="scanvis__cnr scanvis__cnr--tr" />
          <View className="scanvis__cnr scanvis__cnr--bl" />
          <View className="scanvis__cnr scanvis__cnr--br" />
          {/* 提示文案在框内偏下（参考图①的位置），不再另起一行压到切换钮上 */}
          <Text className="scanvis__frame-hint">
            {cameraOn ? '请对准想要搜索的商品，可进行拍摄' : '相机不可用，可改用相册或聊天记录'}
          </Text>
        </View>
      ) : box ? (
        <View
          className="scanvis__crop"
          style={{
            left: `${box.x}px`,
            top: `${box.y}px`,
            width: `${box.w}px`,
            height: `${box.h}px`,
          }}
          onTouchStart={onBoxTouchStart}
          onTouchMove={onBoxTouchMove}
          onTouchEnd={onBoxTouchEnd}
          onTouchCancel={onBoxTouchEnd}
        >
          {corner('tl')}
          {corner('tr')}
          {corner('bl')}
          {corner('br')}
          <View className="scanvis__handle scanvis__handle--t" />
          <View className="scanvis__handle scanvis__handle--b" />
          <View className="scanvis__handle scanvis__handle--l" />
          <View className="scanvis__handle scanvis__handle--r" />
        </View>
      ) : null}
      {/* ---------------- 顶部：返回 + 标题（对齐右侧微信原生胶囊的中线） ---------------- */}
      <View
        className="scanvis__back"
        style={{
          top: `${nav.statusBarHeight + nav.contentHeight / 2}px`,
          ...backGeo.btnStyle,
        }}
        onClick={goBack}
      >
        <View className="scanvis__back-chevron" style={backGeo.chevronStyle} />
      </View>
      <Text
        className="scanvis__title"
        style={{ top: `${nav.statusBarHeight + nav.contentHeight / 2}px` }}
      >
        识图
      </Text>
      {/* ---------------- 提示文案 ---------------- */}
      <Text className="scanvis__lead">
        {phase === 'viewfinder' ? '请对准想要搜索的商品，可进行拍摄' : '拖动四角或边框调整范围'}
      </Text>
      {/* ---------------- 底部：来源 + 快门（取景态）/ 重拍 + 搜索（取框态） ---------------- */}{' '}
      {phase === 'viewfinder' ? (
        <View className="scanvis__actions">
          <View className="scanvis__act" onClick={() => void pickFrom('album')}>
            <View className="scanvis__act-ic scanvis__act-ic--album" />
            <Text className="scanvis__act-label">相册</Text>
          </View>

          <View
            className={`scanvis__shutter${busy ? ' is-busy' : ''}`}
            onClick={() => void shoot()}
          >
            <View className="scanvis__shutter-core" />
          </View>

          <View className="scanvis__act" onClick={() => void pickFrom('chat')}>
            <View className="scanvis__act-ic scanvis__act-ic--chat" />
            <Text className="scanvis__act-label">聊天记录</Text>
          </View>
        </View>
      ) : (
        <View className="scanvis__adjust">
          <View className="scanvis__adjust-ghost" onClick={retake}>
            <Text>重新拍</Text>
          </View>
          <View
            className={`scanvis__adjust-main${busy ? ' is-busy' : ''}`}
            onClick={() => void confirmCrop()}
          >
            <Text>{busy ? '正在上传…' : '搜索'}</Text>
          </View>
        </View>
      )}
      {/* ---------------- 底部：扫码家族切换钮（取景态才有意义） ---------------- */}
      {phase === 'viewfinder' ? <ScanTabs active="vision" /> : null}
      {/*
        离屏画布：只用于裁剪。**必须显式给尺寸**（旧版画布 API 的坐标系就是元素的 CSS 尺寸，
        而 `pxtransform` 只处理样式表，所以这里走行内 px 原样下发）。边长取 1024 ——
        等于 `MAX_CROP_OUTPUT`，够画任何一次裁剪的输出（`position: fixed` 挪出视口，见 scss）。
      */}
      <Canvas
        className="scanvis__canvas"
        canvasId="vision-crop"
        style={{ width: `${MAX_CROP_OUTPUT}px`, height: `${MAX_CROP_OUTPUT}px` }}
      />
    </View>
  )
}

/**
 * 用离屏画布按**图片像素**的源矩形裁一张图，返回新临时文件路径。
 *
 * `drawImage` 的九参形式（`sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight`）从 1.9.0 起支持，
 * 正好完成「按源矩形取一块 + 缩放到目标尺寸」两件事。`ctx.draw(false, cb)` 的**回调必须等** ——
 * 画布是异步提交的，立刻 `canvasToTempFilePath` 会拿到上一帧（或空白）。
 */
function cropImage(
  path: string,
  source: Rect,
  output: { width: number; height: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ctx = Taro.createCanvasContext('vision-crop')
    ctx.drawImage(path, source.x, source.y, source.w, source.h, 0, 0, output.width, output.height)
    ctx.draw(false, () => {
      Taro.canvasToTempFilePath({
        canvasId: 'vision-crop',
        x: 0,
        y: 0,
        width: output.width,
        height: output.height,
        destWidth: output.width,
        destHeight: output.height,
        fileType: 'jpg',
        quality: 0.9,
        success: (res) => resolve(res.tempFilePath),
        fail: () => reject(new Error('裁剪图片失败，请重试')),
      })
    })
  })
}
