import * as React from "react";
import { cn } from "../../lib/utils";

type TabsContextValue = {
  value: string;
  setValue: (value: string) => void;
  id: string;
};
const TabsContext = React.createContext<TabsContextValue | null>(null);
const useTabs = () => {
  const ctx = React.use(TabsContext);
  if (!ctx) throw new Error("Tabs components must be used inside <Tabs>");
  return ctx;
};

function Tabs({
  value,
  defaultValue,
  onValueChange,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "defaultValue"> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}) {
  const [inner, setInner] = React.useState(defaultValue ?? "");
  const current = value ?? inner;
  const id = React.useId();
  const setValue = React.useCallback(
    (next: string) => {
      setInner(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );
  return (
    <TabsContext value={{ value: current, setValue, id }}>
      <div
        data-slot="tabs"
        data-orientation="horizontal"
        className={cn("group/tabs flex flex-col gap-2", className)}
        {...props}
      >
        {children}
      </div>
    </TabsContext>
  );
}

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { variant?: "default" | "line" }) {
  return (
    <div
      role="tablist"
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        "group/tabs-list inline-flex h-10 w-fit items-center justify-center rounded-lg p-1 text-muted-foreground",
        variant === "default" ? "bg-muted" : "gap-1 bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  value,
  className,
  onClick,
  ...props
}: React.ComponentProps<"button"> & { value: string }) {
  const tabs = useTabs();
  const active = tabs.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${tabs.id}-tab-${value}`}
      aria-selected={active}
      aria-controls={`${tabs.id}-panel-${value}`}
      tabIndex={active ? 0 : -1}
      data-slot="tabs-trigger"
      data-state={active ? "active" : "inactive"}
      onClick={(e) => {
        tabs.setValue(value);
        onClick?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const list = e.currentTarget.parentElement;
        const items = Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
        const index = items.indexOf(e.currentTarget);
        const next = items[(index + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
        next?.focus();
        next?.click();
      }}
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // Pill on the default list; a primary underline sitting on the list's bottom edge for the line variant.
        "group-data-[variant=default]/tabs-list:data-[state=active]:bg-background group-data-[variant=default]/tabs-list:data-[state=active]:shadow-xs",
        "group-data-[variant=line]/tabs-list:after:absolute group-data-[variant=line]/tabs-list:after:inset-x-0 group-data-[variant=line]/tabs-list:after:-bottom-1 group-data-[variant=line]/tabs-list:after:h-0.5 group-data-[variant=line]/tabs-list:after:rounded-full group-data-[variant=line]/tabs-list:after:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:after:bg-primary",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  value,
  className,
  ...props
}: React.ComponentProps<"div"> & { value: string }) {
  const tabs = useTabs();
  if (tabs.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${tabs.id}-panel-${value}`}
      aria-labelledby={`${tabs.id}-tab-${value}`}
      data-slot="tabs-content"
      className={cn("mt-2 flex-1 text-sm outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
