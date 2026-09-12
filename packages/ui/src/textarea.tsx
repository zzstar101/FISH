import type * as React from 'react'
import { cn } from './lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-28 w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[15px] leading-relaxed text-ink transition-[color,box-shadow] outline-none placeholder:text-ink-3 focus-visible:border-brand focus-visible:bg-surface disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
