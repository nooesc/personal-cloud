import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive/10 text-destructive dark:bg-destructive/20",
        outline: "border-border text-foreground",
        ghost: "hover:bg-muted hover:text-muted-foreground",
        red: "border-transparent select-none font-medium bg-red-600/20 dark:bg-red-500/15 text-destructive text-xs h-4 px-1 py-1 rounded-md",
        yellow:
          "border-transparent select-none font-medium bg-yellow-600/20 dark:bg-yellow-500/15 dark:text-yellow-500 text-yellow-600 text-xs h-4 px-1 py-1 rounded-md",
        orange:
          "border-transparent select-none font-medium bg-orange-600/20 dark:bg-orange-500/15 dark:text-orange-500 text-orange-600 text-xs h-4 px-1 py-1 rounded-md",
        green:
          "border-transparent select-none font-medium bg-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-500 text-emerald-600 text-xs h-4 px-1 py-1 rounded-md",
        blue: "border-transparent select-none font-medium bg-blue-600/20 dark:bg-blue-500/15 dark:text-blue-500 text-blue-600 text-xs h-4 px-1 py-1 rounded-md",
        blank:
          "border-transparent select-none font-medium dark:bg-white/15 bg-black/15 text-foreground text-xs h-4 px-1 py-1 rounded-md",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
