import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { AlertTriangle, CheckCircle2, Circle, Loader2, Zap } from "lucide-react"

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

const statusIconVariants = cva("shrink-0", {
  variants: {
    status: {
      neutral: "text-muted-foreground",
      running: "text-status-running",
      finished: "text-status-finished",
      active: "text-status-active",
      error: "text-status-error",
    },
    size: {
      sm: "h-3.5 w-3.5",
      md: "h-4 w-4",
    },
  },
  defaultVariants: {
    status: "neutral",
    size: "sm",
  },
})

function defaultStatusIcon(
  status: NonNullable<VariantProps<typeof statusChipVariants>["status"]>,
  size: NonNullable<VariantProps<typeof statusChipVariants>["size"]>
) {
  const className = cn(statusIconVariants({ status, size }));

  if (status === "running") {
    return (
      <Loader2
        className={cn(className, "animate-spin motion-reduce:animate-none")}
        aria-hidden="true"
      />
    );
  }

  if (status === "finished") {
    return <CheckCircle2 className={className} aria-hidden="true" />
  }

  if (status === "active") {
    return <Zap className={className} aria-hidden="true" />
  }

  if (status === "error") {
    return <AlertTriangle className={className} aria-hidden="true" />
  }

  return <Circle className={className} aria-hidden="true" />
}

function StatusChip({
  className,
  status,
  size,
  icon,
  showDot = false,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof statusChipVariants> & {
    icon?: React.ReactNode
    showDot?: boolean
  }) {
  const resolvedStatus = status ?? "neutral"
  const resolvedSize = size ?? "sm"

  return (
    <span
      data-slot="status-chip"
      className={cn(statusChipVariants({ status, size }), className)}
      {...props}
    >
      {icon ? (
        icon
      ) : showDot ? (
        <span className={cn(statusDotVariants({ status }))} aria-hidden="true" />
      ) : (
        defaultStatusIcon(resolvedStatus, resolvedSize)
      )}
      <span>{children}</span>
    </span>
  )
}

export { StatusChip }
