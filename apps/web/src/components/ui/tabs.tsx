import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils";

// Class strings verbatim from Dinghy components/ui/tabs.tsx, with Radix's
// `data-horizontal`/`data-vertical`/`data-active` state selectors mapped onto the
// attributes we emit: `data-[orientation=…]` and `data-[state=active]`.

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
        className={cn("group/tabs flex gap-2 data-[orientation=horizontal]:flex-col", className)}
        {...props}
      >
        {children}
      </div>
    </TabsContext>
  );
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit max-w-full items-center justify-center overflow-x-auto no-scrollbar rounded-lg p-1 text-muted-foreground group-data-[orientation=horizontal]/tabs:h-10 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof tabsListVariants>) {
  return (
    <div
      role="tablist"
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
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
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
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

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
