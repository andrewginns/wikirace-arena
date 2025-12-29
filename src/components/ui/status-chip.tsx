import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const statusChipVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border font-semibold whitespace-nowrap",
  {
    variants: {
      status: {
        neutral: "bg-muted/40 border-border text-muted-foreground",
        running: "bg-status-running/10 border-status-running/30 text-foreground",
        finished: "bg-status-finished/10 border-status-finished/30 text-foreground",
        active: "bg-status-active/10 border-status-active/30 text-foreground",
        error: "bg-status-error/10 border-status-error/30 text-foreground",
      },
      size: {
        sm: "h-5 px-2 text-[11px]",
        md: "h-6 px-2.5 text-xs",
      },
    },
    defaultVariants: {
      status: "neutral",
      size: "sm",
    },
  }
)

const statusDotVariants = cva("h-2 w-2 rounded-full", {
  variants: {
    status: {
      neutral: "bg-muted-foreground/70",
      running: "bg-status-running",
      finished: "bg-status-finished",
      active: "bg-status-active",
      error: "bg-status-error",
    },
  },
  defaultVariants: {
    status: "neutral",
  },
})

function StatusChip({
  className,
  status,
  size,
  icon,
  showDot = true,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof statusChipVariants> & {
    icon?: React.ReactNode
    showDot?: boolean
  }) {
  return (
    <span
      data-slot="status-chip"
      className={cn(statusChipVariants({ status, size }), className)}
      {...props}
    >
      {icon
        ? icon
        : showDot
          ? (
              <span
                className={cn(statusDotVariants({ status }))}
                aria-hidden="true"
              />
            )
          : null}
      <span>{children}</span>
    </span>
  )
}

export { StatusChip }
