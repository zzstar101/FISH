import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { Field, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Loader2, Upload } from 'lucide-react'
import { type ChangeEvent, type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { isUnauthenticatedError } from '../../lib/api-client'
import { currentHref } from '../../lib/redirect'
import { currentSessionGeneration } from '../../lib/session-cache'
import { useAuth } from '../auth/auth-provider'
import {
  isPublishTaskCancelled,
  toUploadableFile,
  uploadListingImage,
  validateImageFile,
} from '../publish/api'
import { type ProfileFieldErrors, profileUpdateErrorView } from './api'
import { useUpdateProfile } from './queries'

export function ProfileEditDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { me } = useAuth()
  if (!me) return null
  return (
    <ProfileEditForm
      key={`${me.id}:${open ? 'open' : 'closed'}`}
      me={me}
      onOpenChange={onOpenChange}
      open={open}
    />
  )
}

function ProfileEditForm({
  me,
  open,
  onOpenChange,
}: {
  me: NonNullable<ReturnType<typeof useAuth>['me']>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const updateProfile = useUpdateProfile(me.id)
  const inputId = useId()
  const uploadController = useRef<AbortController | null>(null)
  const [nickname, setNickname] = useState(me.nickname)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({})

  useEffect(() => {
    if (!open) return
    setNickname(me.nickname)
    setFile(null)
    setPreviewUrl(null)
    setMessage(null)
    setFieldErrors({})
  }, [me.nickname, open])

  useEffect(
    () => () => {
      uploadController.current?.abort()
      if (previewUrl !== null) URL.revokeObjectURL(previewUrl)
    },
    [previewUrl],
  )

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null
    event.target.value = ''
    if (!selected) return

    if (previewUrl !== null) URL.revokeObjectURL(previewUrl)
    setFile(selected)
    setPreviewUrl(URL.createObjectURL(selected))
    setMessage(null)
    setFieldErrors((current) => ({ ...current, avatarObjectKey: undefined }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextNickname = nickname.trim()
    const nextErrors: ProfileFieldErrors = {}

    if (nextNickname.length < 1 || nextNickname.length > 20) {
      nextErrors.nickname = '昵称需要 1–20 个字符'
    }

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors)
      setMessage(null)
      return
    }

    setMessage(null)
    setFieldErrors({})

    let avatarObjectKey: string | undefined
    if (file !== null) {
      const uploadable = await toUploadableFile(file)
      if (uploadable === null) {
        setFieldErrors({ avatarObjectKey: '无法读取或转换这张图片' })
        return
      }
      const invalid = validateImageFile(uploadable)
      if (invalid !== null) {
        setFieldErrors({ avatarObjectKey: invalid })
        return
      }

      const generation = currentSessionGeneration()
      const controller = new AbortController()
      uploadController.current?.abort()
      uploadController.current = controller
      setUploading(true)
      try {
        avatarObjectKey = await uploadListingImage(uploadable, {
          signal: controller.signal,
          isCurrent: () => generation === currentSessionGeneration(),
        })
      } catch (error) {
        if (isPublishTaskCancelled(error)) return
        if (isUnauthenticatedError(error)) {
          window.location.assign(`/pc/login?redirect=${encodeURIComponent(currentHref())}`)
          return
        }
        setFieldErrors({ avatarObjectKey: '头像上传失败，请重试' })
        return
      } finally {
        if (uploadController.current === controller) uploadController.current = null
        setUploading(false)
      }
    }

    const input = {
      ...(nextNickname === me.nickname ? {} : { nickname: nextNickname }),
      ...(avatarObjectKey === undefined ? {} : { avatarObjectKey }),
    }
    if (Object.keys(input).length === 0) {
      setMessage('没有需要保存的修改')
      return
    }

    try {
      await updateProfile.mutateAsync(input)
      onOpenChange(false)
    } catch (error) {
      const view = profileUpdateErrorView(error)
      setMessage(view.message)
      setFieldErrors(view.fields)
    }
  }

  const submitting = uploading || updateProfile.isPending

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-xl">编辑个人资料</DialogTitle>
          <DialogDescription>头像与昵称会同步显示在顶栏和商品卖家信息中。</DialogDescription>
        </DialogHeader>

        <form className="space-y-5" onSubmit={(event) => void submit(event)}>
          <div className="flex items-center gap-5 rounded-2xl bg-surface-2 p-4">
            <UserAvatar
              avatarUrl={previewUrl ?? me.avatarUrl}
              className="size-20"
              emoji={me.nickname.slice(0, 1)}
              fallbackClassName="text-2xl"
              size="xl"
            />
            <div className="min-w-0">
              <label
                className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-4 font-medium text-sm transition-colors hover:bg-brand-soft hover:text-brand"
                htmlFor={inputId}
              >
                <Upload className="size-4" />
                选择头像
              </label>
              <input
                accept="image/jpeg,image/png,image/webp,image/heic"
                className="sr-only"
                id={inputId}
                onChange={chooseFile}
                type="file"
              />
              <p className="mt-2 text-ink-3 text-xs">支持 JPG / PNG / WebP，单张不超过 5MB。</p>
            </div>
          </div>
          {fieldErrors.avatarObjectKey !== undefined ? (
            <p className="text-danger text-sm">{fieldErrors.avatarObjectKey}</p>
          ) : null}

          <Field data-invalid={fieldErrors.nickname !== undefined}>
            <FieldLabel htmlFor="nickname">昵称</FieldLabel>
            <Input
              aria-invalid={fieldErrors.nickname !== undefined}
              id="nickname"
              maxLength={20}
              onChange={(event) => {
                setNickname(event.target.value)
                setFieldErrors((current) => ({ ...current, nickname: undefined }))
              }}
              value={nickname}
            />
            {fieldErrors.nickname !== undefined ? (
              <FieldError>{fieldErrors.nickname}</FieldError>
            ) : (
              <p className="text-ink-3 text-xs">1–20 个字符。</p>
            )}
          </Field>

          {message !== null ? (
            <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger text-sm" role="alert">
              {message}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              type="button"
              variant="outline"
            >
              取消
            </Button>
            <Button disabled={submitting} type="submit">
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              {uploading ? '正在上传…' : updateProfile.isPending ? '正在保存…' : '保存修改'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
