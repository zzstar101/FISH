/**
 * 发布页图片上传适配器（#6 契约 §2.7：presign → 客户端直传对象存储 → confirm）。
 *
 * 为什么直传：图片字节不经过业务 API（省一次中转），服务端只签发一次性 PUT URL，
 * 再用 `confirm` 对对象存储发 HEAD 复核真实大小与 mime（presign 的签名只覆盖 host，
 * 声明值不可信，见契约 §7.7）。
 *
 * 与 PC Web 端 `apps/web-pc/src/features/publish/api.ts` 同一套三步语义，差异只有平台层：
 * 1. 小程序读本地临时文件要 `getFileSystemManager().readFile`（**不传 encoding**，
 *    传 utf8 会把二进制读坏），浏览器直接拿 `File`；
 * 2. 直传用 `Taro.request`（PUT + ArrayBuffer），浏览器用 `fetch`；
 * 3. 小程序没有 `canvas`，HEIC 只能明确拒绝，不做转码 —— 这里与 Web 的差别是
 *    **已知且有意的**：`ALLOWED_IMAGE_MIME` 本来就不含 `image/heic`。
 *
 * 生产语义：失败就抛错，绝不静默换成本地假图（见 `lib/request.ts` 的失败口径）。
 */
import { UPLOAD_ROUTES } from '@fish/contracts/listings/routes'
import {
  MAX_IMAGE_BYTES,
  UploadConfirmResponseSchema,
  UploadPresignResponseSchema,
} from '@fish/contracts/listings/schema'
import Taro from '@tarojs/taro'
import { apiRequest } from '@/lib/request'
import { assertUploadActive } from './active'
import { isChooseMediaCancel } from './choose-error'
import { type AllowedImageMime, mimeFromPath } from './mime'
import { PHOTO_SOURCE_OPTIONS, type PhotoSource, photoSourceFromTapIndex } from './photo-source'

/**
 * 直传超时：5MB 弱网首包可能很慢，比普通请求的 15s 宽。
 *
 * 导出给识图查询图上传复用（`features/visual-search/api.ts`）：两处都是"读本地文件 → PUT 直传"，
 * 同一条链路该有同一个超时口径。
 */
export const UPLOAD_TIMEOUT_MS = 60_000

/** 与契约同源的大小上限：超了直接给文案，不打 API。 */
export function validatePickedSize(sizeBytes: number): string | null {
  if (sizeBytes > MAX_IMAGE_BYTES) return '单张图片不能超过 5MB'
  return null
}

/** 已选图片：本地路径只用于预览与上传，不落任何后端字段。 */
export type PickedPhoto = {
  path: string
  mime: AllowedImageMime
  sizeBytes: number
}

export type PickResult = {
  photos: PickedPhoto[]
  /** 被本地校验挡下的原因（只保留最后一条），`null` = 全部通过 */
  rejected: string | null
}

/** 平台选图 API 给出的文件：两个 API 的字段名不同（`tempFilePath` vs `path`），这里先归一。 */
type PickedFile = { path: string; size: number }

/**
 * 逐张本地校验：只保留白名单格式与大小内的，不合规的回报原因。
 *
 * 两个选图入口（`chooseMedia` / `chooseMessageFile`）共用这一步 —— 校验口径只有一份，
 * 否则「相册能过、聊天记录过不了」这类差异会变成用户眼里的玄学。
 */
function collectPhotos(files: PickedFile[]): PickResult {
  const photos: PickedPhoto[] = []
  let rejected: string | null = null
  for (const file of files) {
    const mime = mimeFromPath(file.path)
    if (!mime) {
      rejected = '仅支持 JPG / PNG / WebP 图片'
      continue
    }
    const tooBig = validatePickedSize(file.size)
    if (tooBig) {
      rejected = tooBig
      continue
    }
    photos.push({ path: file.path, mime, sizeBytes: file.size })
  }
  return { photos, rejected }
}

/**
 * 选图。最多 `limit` 张，只挑图片。
 *
 * **只有用户取消**才当「没选」返回空数组（否则每次取消都会弹一个吓人的错误）；
 * 权限被拒 / 相机异常 / 平台失败一律抛出可展示的错误，由页面提示并让用户重试。
 * 不合规的（HEIC / 超 5MB）逐张跳过并回报原因。
 */
export async function pickPhotos(limit: number): Promise<PickResult> {
  if (limit <= 0) return { photos: [], rejected: null }

  let result: Taro.chooseMedia.SuccessCallbackResult
  try {
    result = await Taro.chooseMedia({
      count: limit,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      // compressed：iOS 相册原图常是 HEIC，压缩后通常是 JPG，能直接过契约白名单
      sizeType: ['compressed'],
    })
  } catch (error) {
    // 只吞「用户取消」；权限被拒 / 相机异常 / 平台失败必须冒泡给页面去提示
    if (isChooseMediaCancel(error)) return { photos: [], rejected: null }
    throw new Error('无法选择图片，请检查相册/相机权限后重试')
  }

  return collectPhotos(
    result.tempFiles.map((file) => ({ path: file.tempFilePath, size: file.size })),
  )
}

/**
 * 单张取图：先弹**来源弹窗**（拍摄 / 从相册选择 / 从聊天会话选择），再按来源调对应的
 * 微信原生取图 API。识图入口页与搜索页的识图按钮共用这一条链。
 *
 * | 来源 | 原生 API | 面板 |
 * | --- | --- | --- |
 * | 拍摄 | `chooseMedia`（`sourceType: ['camera']`） | 系统相机 |
 * | 从相册选择 | `chooseMedia`（`sourceType: ['album']`） | 系统相册（`compressed` 压过再给） |
 * | 从聊天会话选择 | `chooseMessageFile`（`type: 'image'`） | 微信会话文件选择器 |
 *
 * **为什么是弹窗 + 分派而不是一次调用**：`chooseMedia` 的原生面板只有「拍摄 / 相册」
 * 两项，而「从聊天会话选择」是另一个独立面板（`chooseMessageFile`），没有一次调用能同时
 * 给出三种来源。弹窗项与分派在 `./photo-source`（纯逻辑，可单测）。
 *
 * **取消**（弹窗取消 / 面板取消）统一返回空结果、不报错：取消是正常路径。
 * 权限被拒与平台失败照旧抛出可展示的错误，由调用方提示并让用户重试。
 */
export async function pickPhotoFromSource(): Promise<PickResult> {
  let tapIndex: number
  try {
    const picked = await Taro.showActionSheet({ itemList: [...PHOTO_SOURCE_OPTIONS] })
    tapIndex = picked.tapIndex
  } catch {
    // 用户取消 / 点蒙层：`showActionSheet` 以 reject 收场，这不是错误
    return { photos: [], rejected: null }
  }
  const source: PhotoSource | null = photoSourceFromTapIndex(tapIndex)
  // 越界（理论上不可达）：与取消同一处置，不把一次平台抖动变成用户可见的报错
  if (source === null) return { photos: [], rejected: null }

  if (source === 'chat') {
    let result: Taro.chooseMessageFile.SuccessCallbackResult
    try {
      // `type: 'image'` 已经在平台侧过滤过一遍；本地仍按同一套白名单与大小复核
      result = await Taro.chooseMessageFile({ count: 1, type: 'image' })
    } catch (error) {
      if (isChooseMediaCancel(error)) return { photos: [], rejected: null }
      throw new Error('无法从聊天记录选择图片，请重试')
    }
    return collectPhotos(result.tempFiles.map((file) => ({ path: file.path, size: file.size })))
  }

  let result: Taro.chooseMedia.SuccessCallbackResult
  try {
    result = await Taro.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: [source],
      sizeType: ['compressed'],
    })
  } catch (error) {
    if (isChooseMediaCancel(error)) return { photos: [], rejected: null }
    throw new Error('无法选择图片，请检查相册/相机权限后重试')
  }
  return collectPhotos(
    result.tempFiles.map((file) => ({ path: file.tempFilePath, size: file.size })),
  )
}

/**
 * 把读到的内容收敛成 ArrayBuffer。
 *
 * **不能只写 `data instanceof ArrayBuffer`**：开发者工具里这个对象可能来自另一个 realm，
 * `instanceof` 会是 false（对象本身是好的），于是把「读成功」误报成「读取失败」。
 * `ArrayBuffer.isView` 覆盖 `Uint8Array` 等视图（devtools 上读出来是哪种没有文档保证）。
 */
function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return data as ArrayBuffer
  return null
}

/**
 * 读本地文件为二进制。
 *
 * 优先异步 `readFile`（**不传 encoding**：传 utf8 会把二进制读坏），
 * 失败或拿到的不是二进制时退到 `readFileSync` —— 开发工具与真机上
 * 「异步读临时文件偶发失败」是已知现象，同步读能兜住同一次上传。
 *
 * 导出给识图查询图上传复用（`features/visual-search/api.ts`）：realm 判据（`toArrayBuffer`）
 * 是踩过坑的，两处各写一份迟早漂移。
 */
export function readFileBuffer(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fs = Taro.getFileSystemManager()

    const accept = (raw: unknown, via: string): boolean => {
      const buffer = toArrayBuffer(raw)
      if (buffer) {
        resolve(buffer)
        return true
      }
      console.error(`[upload] ${via} 读到的不是二进制内容`, typeof raw)
      return false
    }

    const readSync = () => {
      try {
        if (!accept(fs.readFileSync(filePath), 'readFileSync')) {
          reject(new Error('图片读取失败,请重试'))
        }
      } catch (error) {
        console.error('[upload] readFileSync 失败', error)
        reject(new Error('图片读取失败,请重试'))
      }
    }

    try {
      fs.readFile({
        filePath,
        success: (res) => {
          if (!accept(res.data, 'readFile')) readSync()
        },
        fail: (error) => {
          console.error('[upload] readFile 失败', error?.errMsg)
          readSync()
        },
      })
    } catch (error) {
      console.error('[upload] readFile 抛异常', error)
      readSync()
    }
  })
}

/**
 * 单张图片上传，返回 `objectKey`（只有它进 create / update 的 `objectKeys`）。
 *
 * **一张一次调用，独立失败**：出物页在用户**选中图片时**就调用本函数，并自行维护每张图的
 * 「上传中 / 已上传 / 重传」状态。这里刻意不做批量：一张失败不牵连其余张，
 * 重试也只是对那一张再调一次（presign 只签一次用途，重试会重新签）。
 *
 * `isActive` 是调用方的在途判据（出物页传 `() => taskAlive(task)`）：三步里**每一次**
 * 发请求前都会问一遍，换号 / 卸载后立刻中止，不再发出后续鉴权请求（#170 复查 #208）。
 */
export async function uploadListingImage(
  photo: PickedPhoto,
  isActive?: () => boolean,
): Promise<string> {
  assertUploadActive(isActive)
  const presign = UploadPresignResponseSchema.parse(
    await apiRequest(UPLOAD_ROUTES.presign, {
      method: 'POST',
      body: { contentType: photo.mime, sizeBytes: photo.sizeBytes },
    }),
  )

  const buffer = await readFileBuffer(photo.path)
  // 直传 PUT 不携带会话（只有 presign 的签名），但它会在对象存储里留下真实对象 ——
  // 换号后这一发同样不该再发。
  assertUploadActive(isActive)
  const uploaded = await Taro.request({
    url: presign.uploadUrl,
    method: 'PUT',
    data: buffer,
    // `presign.headers` 当前是空对象（契约 §7.7：签名只覆盖 host），但对象存储会把
    // PUT 的 Content-Type 落成对象 mime，而 create 时 `assertUsableObjectKeys` 按 mime 校验，
    // 所以必须显式带上。
    header: { ...presign.headers, 'content-type': photo.mime },
    timeout: UPLOAD_TIMEOUT_MS,
  })
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300) {
    throw new Error('图片上传失败,请重试')
  }

  assertUploadActive(isActive)
  const confirmed = UploadConfirmResponseSchema.parse(
    await apiRequest(UPLOAD_ROUTES.confirm, {
      method: 'POST',
      body: { objectKey: presign.objectKey },
    }),
  )
  return confirmed.objectKey
}
