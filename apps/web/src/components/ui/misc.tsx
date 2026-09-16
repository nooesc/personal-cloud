import { AlertTriangle, Check } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";

function Separator({
  orientation = "horizontal",
  className,
  ...props
}: React.ComponentProps<"div"> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <div
      data-slot="separator"
      data-orientation={orientation}
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch",
        className,
      )}
      {...props}
    />
  );
}

function Alert({
  variant = "default",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { variant?: "default" | "destructive" | "success" }) {
  return (
    <div
      role={variant === "destructive" ? "alert" : "status"}
      data-slot="alert"
      className={cn(
        "group/alert relative grid w-full gap-0.5 rounded-lg border p-4 text-left text-sm has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
        variant === "default" && "bg-card text-card-foreground",
        variant === "destructive" &&
          "border-destructive/40 bg-destructive/10 text-destructive dark:bg-destructive/10",
        variant === "success" && "border-primary/30 bg-primary/10 text-primary",
        className,
      )}
      {...props}
    >
      {variant === "destructive" && <AlertTriangle />}
      {variant === "success" && <Check />}
      {children}
    </div>
  );
}

/** Dinghy's service status dot: accent green glows, running pulses, errors go destructive. */
const statusDot: Record<string, string> = {
  done: "bg-primary shadow-[0_0_8px] shadow-primary/40",
  healthy: "bg-primary shadow-[0_0_8px] shadow-primary/40",
  online: "bg-primary shadow-[0_0_8px] shadow-primary/40",
  running: "bg-primary shadow-[0_0_8px] shadow-primary/40 animate-pulse",
  building: "bg-yellow-500 animate-pulse",
  deploying: "bg-yellow-500 animate-pulse",
  queued: "bg-yellow-500 animate-pulse",
  pending: "bg-yellow-500 animate-pulse",
  provisioning: "bg-yellow-500 animate-pulse",
  degraded: "bg-yellow-500",
  error: "bg-destructive",
  failed: "bg-destructive",
  unhealthy: "bg-destructive",
  offline: "bg-destructive",
  idle: "bg-muted-foreground",
};

function StatusDot({
  status,
  className,
  title,
}: {
  status?: string | null;
  className?: string;
  title?: string;
}) {
  const key = (status ?? "idle").toLowerCase();
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title ?? key}
      className={cn("inline-block size-2 shrink-0 rounded-full", statusDot[key] ?? statusDot.idle, className)}
    />
  );
}

function Eyebrow({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("gh-eyebrow", className)} {...props} />;
}

function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center gap-4 py-16 text-center",
        className,
      )}
    >
      <div className="rounded-xl bg-muted p-3 text-muted-foreground [&_svg]:size-6">{icon}</div>
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-[15px] font-medium">{title}</span>
        <span className="gh-eyebrow max-w-md normal-case tracking-normal text-[11px]">{description}</span>
      </div>
      {action}
    </div>
  );
}

/** Dinghy's mono metadata idiom. */
function Meta({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span className={cn("font-mono text-[11px] text-muted-foreground tabular-nums", className)} {...props} />
  );
}

export { Separator, Alert, StatusDot, statusDot, Eyebrow, EmptyState, Meta };
