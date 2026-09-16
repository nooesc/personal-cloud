import { X } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

/**
 * Native <dialog> with shadcn's DialogContent classes. Platform focus trapping and
 * Escape handling stay free; the backdrop is styled in styles.css.
 */
function Dialog({
  title,
  description,
  onClose,
  size = "default",
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  onClose: () => void;
  size?: "default" | "wide";
  className?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    el.showModal();
    el.querySelector<HTMLElement>("input:not([type=checkbox]):not([readonly]), select, textarea")?.focus({ preventScroll: true });
    return () => {
      el.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      data-slot="dialog-content"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "fixed top-1/2 left-1/2 z-50 m-0 flex max-h-[90vh] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto overscroll-contain rounded-xl bg-popover p-6 text-sm text-popover-foreground outline-none",
        size === "wide" ? "sm:max-w-3xl" : "sm:max-w-lg",
        className,
      )}
    >
      <div data-slot="dialog-header" className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} data-slot="dialog-title" className="text-base leading-none font-medium">
            {title}
          </h2>
          <Button
            variant="ghost"
            size="icon-xs"
            className="-mt-1 -mr-1 text-muted-foreground"
            onClick={onClose}
            aria-label="Close"
          >
            <X />
          </Button>
        </div>
        {description && (
          <p data-slot="dialog-description" className="text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </dialog>
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export { Dialog, DialogFooter };
