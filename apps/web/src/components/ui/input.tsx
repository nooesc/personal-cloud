import { ChevronDown, EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";

const fieldClasses =
  "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  const [show, setShow] = React.useState(false);
  const isPassword = type === "password";
  return (
    <div className="relative w-full">
      <input
        type={isPassword ? (show ? "text" : "password") : type}
        data-slot="input"
        className={cn(fieldClasses, isPassword && "pr-10", className)}
        {...props}
      />
      {isPassword && (
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground focus:outline-none"
          onClick={() => setShow((v) => !v)}
          tabIndex={-1}
          aria-label={show ? "Hide value" : "Show value"}
        >
          {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </button>
      )}
    </div>
  );
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-[80px] w-full [overflow-wrap:anywhere] rounded-lg border border-input bg-transparent px-3 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

function Select({
  className,
  size = "default",
  children,
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <div className="relative w-full">
      <select
        data-slot="select-trigger"
        data-size={size}
        className={cn(
          "flex w-full appearance-none items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-8 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
          size === "default" ? "h-9" : "h-8 rounded-[min(var(--radius-md),10px)]",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 appearance-none rounded-[4px] border border-input bg-card transition-colors outline-none checked:border-primary focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

function Switch({
  checked,
  onCheckedChange,
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"button">, "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  size?: "sm" | "default";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      data-size={size}
      data-state={checked ? "checked" : "unchecked"}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        size === "default" ? "h-5 w-9" : "h-[14px] w-[24px]",
        checked ? "bg-primary" : "bg-input dark:bg-input/80",
        className,
      )}
      {...props}
    >
      <span
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background shadow-xs ring-0 transition-transform",
          size === "default" ? "size-4" : "size-2.5",
          checked
            ? size === "default"
              ? "translate-x-[calc(100%+2px)]"
              : "translate-x-[calc(100%+1px)]"
            : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export { Input, Textarea, Select, Label, Checkbox, Switch, fieldClasses };
