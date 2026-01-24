import type { ReactNode } from "react";
import { AlertTriangle, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

export function ErrorCallout({
  children,
  size = "sm",
  right,
  className,
}: {
  children: ReactNode;
  size?: "sm" | "xs";
  right?: ReactNode;
  className?: string;
}) {
  const hasRight = Boolean(right);
  return (
    <div
      className={cn(
        "rounded-md border border-status-error/30 bg-status-error/10 p-3 text-foreground",
        size === "xs" ? "text-xs" : "text-sm",
        hasRight
          ? "flex flex-wrap items-start justify-between gap-2"
          : "flex items-start gap-2",
        className
      )}
    >
      <div className={cn("flex items-start gap-2", hasRight && "min-w-0")}>
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-status-error"
          aria-hidden="true"
        />
        <div className={cn(hasRight && "min-w-0")}>{children}</div>
      </div>
      {hasRight ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

export function ServerOfflineCallout({
  children,
  size = "sm",
  tone = "muted",
  className,
}: {
  children: ReactNode;
  size?: "sm" | "xs";
  tone?: "muted" | "active";
  className?: string;
}) {
  const isActive = tone === "active";

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-3",
        size === "xs" ? "text-xs" : "text-sm",
        isActive
          ? "border-status-active/30 bg-status-active/10 text-foreground"
          : "bg-muted/40 text-muted-foreground",
        className
      )}
    >
      <WifiOff
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          isActive && "text-status-active"
        )}
        aria-hidden="true"
      />
      <div>{children}</div>
    </div>
  );
}
