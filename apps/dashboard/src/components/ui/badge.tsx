import * as React from "react";
import { cn } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "secondary" | "outline" | "destructive" | "success" | "warning" | "cyan" | "purple";
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
        {
          "bg-primary text-primary-foreground border-transparent shadow hover:bg-primary/80": variant === "default",
          "bg-secondary text-secondary-foreground border-transparent hover:bg-secondary/80": variant === "secondary",
          "text-foreground border-border": variant === "outline",
          "bg-destructive/15 text-destructive border-destructive/30": variant === "destructive",
          "bg-emerald-500/15 text-emerald-400 border-emerald-500/30": variant === "success",
          "bg-amber-500/15 text-amber-400 border-amber-500/30": variant === "warning",
          "bg-cyan-500/15 text-cyan-400 border-cyan-500/30": variant === "cyan",
          "bg-purple-500/15 text-purple-400 border-purple-500/30": variant === "purple",
        },
        className
      )}
      {...props}
    />
  );
}

export { Badge };
