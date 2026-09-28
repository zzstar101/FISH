import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  effectiveNegotiable,
  INITIAL_PUBLISH_FORM,
  listingErrorView,
  type PublishImage,
  parsePriceToCents,
  polishCooldownUntilFrom,
  polishFailureView,
  polishInputKey,
  publishFieldErrorsFromDetails,
  publishImageCheck,
  publishImageHelperText,
  uploadFailureMessage,
  validatePublishForm,
} from './form-model'

function image(status: PublishImage['status']): PublishImage {
  const sourceFile = new File(['image'], `${status}.jpg`, { type: 'image/jpeg' })
  return {
    id: status,
    sourceFile,
    file: status === 'preparing' || status === 'failed' ? null : sourceFile,
    previewUrl: status === 'preparing' ? '' : `blob:${status}`,
    status,
    objectKey: status === 'uploaded' ? 'listings/u/a.jpg' : null,
    error: status === 'failed' ? '上传失败' : null,
  }
}

const validForm = {
  ...INITIAL_PUBLISH_FORM,
  title: '高等数学教材',
  description: '九成新，无笔记。',
  price: '12.50',
  category: 'BOOKS' as const,
}

describe('publish form model', () => {
  test('parses decimal yuan to integer cents and forces free listings to zero', () => {
    expect(parsePriceToCents('12.50', false)).toBe(1250)
    expect(parsePriceToCents('0.01', false)).toBe(1)
    expect(parsePriceToCents('12.345', false)).toBeNull()
    expect(parsePriceToCents('999999', false)).toBeNull()
    expect(parsePriceToCents('', true)).toBe(0)
  })

  test('represents preparing, uploading and failed image states explicitly', () => {
    expect(publishImageCheck([image('preparing')])).toEqual({
      done: false,
      label: '图片处理中…',
    })
    expect(publishImageHelperText([image('preparing')])).toBe('图片处理完成后即可提交')
    expect(publishImageCheck([image('uploading')]).label).toBe('图片上传中…')
    expect(publishImageCheck([image('failed')]).label).toBe('有图片处理失败，请重试')
    expect(publishImageCheck([image('uploaded')])).toEqual({
      done: true,
      label: '1 张图片已上传',
    })
  })

  test('rejects a form while any image is still uploading or failed', () => {
    expect(validatePublishForm(validForm, [image('uploaded')])).toEqual({})
    expect(validatePublishForm(validForm, [image('preparing')]).images).toBe(
      '请等待图片处理完成，失败图片需先重试',
    )
    expect(validatePublishForm(validForm, [image('uploading')]).images).toBe(
      '请等待图片处理完成，失败图片需先重试',
    )
    expect(validatePublishForm(validForm, [image('failed')]).images).toBe(
      '请等待图片处理完成，失败图片需先重试',
    )
  })

  test('locks negotiation for free listings and keeps transport errors readable', () => {
    expect(effectiveNegotiable({ free: true, negotiable: true })).toBe(false)
    expect(effectiveNegotiable({ free: false, negotiable: true })).toBe(true)
    expect(uploadFailureMessage(new Error('Failed to fetch'))).toBe('图片上传失败，请重试')
    expect(
      uploadFailureMessage(new ApiError('UPLOAD_OBJECT_MISSING', 422, '图片尚未上传完成')),
    ).toBe('图片尚未上传完成')
    // #286：confirm 这一步现在会带着内容审核结论失败（BLOCK / 审核服务不可用），上传位必须把服务端
    // 的中文文案原样给用户，而不是退化成错误码或浏览器的英文底层报错。
    expect(
      uploadFailureMessage(new ApiError('IMAGE_CONTENT_BLOCKED', 422, '图片内容未通过审核')),
    ).toBe('图片内容未通过审核')
    expect(
      uploadFailureMessage(
        new ApiError('CONTENT_MODERATION_UNAVAILABLE', 503, '图片审核暂时不可用，请稍后重试'),
      ),
    ).toBe('图片审核暂时不可用，请稍后重试')
  })

  test('maps BLOCK details to the matching visible fields', () => {
    const errors = publishFieldErrorsFromDetails([
      { field: 'title', message: '标题有违规内容' },
      { field: 'description', message: '描述有违规内容' },
      { field: 'unknown', message: '忽略' },
    ])
    expect(errors).toEqual({ title: '标题有违规内容', description: '描述有违规内容' })

    const view = listingErrorView(
      new ApiError('LISTING_CONTENT_BLOCKED', 422, '商品内容未通过审核', [
        { field: 'title', message: '标题有违规内容' },
      ]),
    )
    expect(view.fieldErrors.title).toBe('标题有违规内容')
    expect(view.message).toBe('标题中有违规内容')
  })

  test('keeps AI failure semantics explicit', () => {
    expect(polishFailureView('AI_POLISH_QUOTA', 30)).toMatchObject({
      message: '操作太频繁，30 秒后可重试',
      canRetry: true,
    })
    expect(polishCooldownUntilFrom(30, 1_000)).toBe(31_000)
    expect(polishCooldownUntilFrom(undefined, 1_000)).toBe(Number.POSITIVE_INFINITY)
    expect(polishFailureView('AI_TIMEOUT').canRetry).toBe(true)
    expect(polishFailureView('AI_RESULT_EMPTY').message).toBe('没有可用候选')
    expect(polishFailureView('AI_NOT_CONFIGURED').canRetry).toBe(false)
  })

  test('keys AI responses to the exact form content that requested them', () => {
    const form = { title: '  教材  ', description: '九成新', category: 'BOOKS' as const }
    expect(polishInputKey(form)).toBe(
      polishInputKey({ title: '教材', description: '九成新', category: 'BOOKS' }),
    )
    expect(polishInputKey(form)).not.toBe(
      polishInputKey({ title: '教材', description: '全新未拆', category: 'BOOKS' }),
    )
  })
})
