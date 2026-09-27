/**
 * provider 工厂（#228）：按 transport 选实现。
 *
 * 业务层只依赖 `ContentModerationProvider` 这个接口，既不感知腾讯 SDK/TC3 签名细节，
 * 也不感知本地词表；换 transport 不改调用方代码。
 */
import type { ContentModerationEnv } from '@fish/shared/env'
import { createLocalContentModerationProvider } from './local'
import { createTencentContentModerationProvider, type LoadModerationImage } from './tencent'
import type { ContentModerationProvider } from './types'

export type ContentModerationProviderOptions = {
  /**
   * 读取对象存储里的图片字节（图片审核必需）。
   * 生产上传路径的接线由后续 Issue 负责；适配器只要求调用方提供这个函数，因此可注入、可测。
   */
  loadImage: LoadModerationImage
}

export function createContentModerationProvider(
  env: ContentModerationEnv,
  options: ContentModerationProviderOptions,
): ContentModerationProvider {
  if (env.transport === 'local') return createLocalContentModerationProvider()
  return createTencentContentModerationProvider(
    {
      secretId: env.secretId,
      secretKey: env.secretKey,
      region: env.region,
      tmsBizType: env.tmsBizType,
      imsBizType: env.imsBizType,
    },
    { loadImage: options.loadImage },
  )
}
