import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";
import { DitherGradient } from "../dither-kit";
import { cn } from "../../lib/utils";
import { hostCss } from "./palette";
import type { FleetHostView } from "./use-fleet";

/** ease-out-expo — quick start, long soft settle. */
const EASE = [0.16, 1, 0.3, 1] as const;

interface RevealProps {
	delay?: number;
	/** `li` inside lists so the markup stays valid */
	as?: "div" | "li";
	className?: string;
	children: ReactNode;
}

/** Fade + lift entrance; renders settled under prefers-reduced-motion. */
export const Reveal = ({
	delay = 0,
	as = "div",
	className,
	children,
}: RevealProps) => {
	const reduce = useReducedMotion();
	const Tag = as === "li" ? motion.li : motion.div;
	return (
		<Tag
			className={className}
			initial={reduce ? false : { opacity: 0, y: 10 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.55, ease: EASE, delay }}
		>
			{children}
		</Tag>
	);
};

interface CurtainProps {
	delay?: number;
	className?: string;
}

/**
 * Left-to-right wipe for the live charts: a card-coloured curtain that slides
 * off, then unmounts so it never clips the gliding tooltip. The kit's own
 * entrance is off on these charts because it re-plays on every data change,
 * which would flash every 15s poll.
 */
export const Curtain = ({ delay = 0, className }: CurtainProps) => {
	const reduce = useReducedMotion();
	const [done, setDone] = useState(false);
	if (done || reduce) return null;
	return (
		<motion.div
			aria-hidden
			className={cn(
				"pointer-events-none absolute inset-0 z-10 origin-right bg-card",
				className,
			)}
			initial={{ scaleX: 1 }}
			animate={{ scaleX: 0 }}
			transition={{ duration: 0.9, ease: EASE, delay }}
			onAnimationComplete={() => setDone(true)}
		/>
	);
};

interface HostSwatchProps {
	host: Pick<FleetHostView, "color" | "status">;
	className?: string;
}

/** The host's colour square, as used by the kit legend; goes red when unreachable. */
export const HostSwatch = ({ host, className }: HostSwatchProps) => {
	const unreachable = host.status.state === "unreachable";
	return (
		<span
			aria-hidden
			className={cn("inline-block size-2 shrink-0 rounded-[1px]", className)}
			style={{
				backgroundColor: unreachable
					? "var(--destructive)"
					: hostCss(host.color),
				boxShadow: unreachable
					? undefined
					: `0 0 6px ${hostCss(host.color, 0.55)}`,
			}}
		/>
	);
};

interface HostChipProps {
	host: FleetHostView;
	/** Isolated in the shared charts */
	selected: boolean;
	/** Another host is isolated */
	dimmed: boolean;
	/** False when the host has no samples in the window — nothing to isolate */
	isolatable: boolean;
	onSelect: (key: string | null) => void;
	onSpotlight: (key: string | null) => void;
}

/** Legend entry shared by both charts; click isolates, hover spotlights. */
export const HostChip = ({
	host,
	selected,
	dimmed,
	isolatable,
	onSelect,
	onSpotlight,
}: HostChipProps) => {
	const unreachable = host.status.state === "unreachable";
	// Inline colours only while selected — otherwise they'd beat the
	// .gh-interactive hover rules.
	return (
		<button
			type="button"
			disabled={!isolatable}
			aria-pressed={selected}
			title={
				isolatable
					? selected
						? `Show every host`
						: `Isolate ${host.name}`
					: `${host.name}: no samples yet`
			}
			onClick={() => onSelect(selected ? null : host.key)}
			onPointerEnter={() => onSpotlight(host.key)}
			onPointerLeave={() => onSpotlight(null)}
			onFocus={() => onSpotlight(host.key)}
			onBlur={() => onSpotlight(null)}
			className={cn(
				"gh-interactive flex h-6 items-center gap-1.5 rounded border border-border px-2 font-mono text-[11px] text-muted-foreground",
				"disabled:cursor-default disabled:opacity-50",
				isolatable && "cursor-pointer hover:text-foreground",
				selected && "text-foreground",
				dimmed && "opacity-40",
			)}
			style={
				selected
					? {
							backgroundColor: hostCss(host.color, 0.14),
							borderColor: hostCss(host.color, 0.5),
						}
					: undefined
			}
		>
			<HostSwatch host={host} />
			<span className="max-w-32 truncate">{host.name}</span>
			{unreachable && (
				<span className="text-[10px] uppercase tracking-[0.08em] text-destructive">
					down
				</span>
			)}
		</button>
	);
};

interface CollectingProps {
	className?: string;
	hint?: string;
}

/** Grey dither placeholder while fewer than two samples exist. */
export const Collecting = ({
	className,
	hint = "collecting samples",
}: CollectingProps) => (
	<div
		role="status"
		className={cn(
			"relative flex items-center justify-center overflow-hidden rounded",
			className,
		)}
	>
		<DitherGradient from="grey" direction="up" cell={3} opacity={0.35} />
		<span className="relative flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
			<span
				aria-hidden
				className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
			/>
			{hint}
		</span>
	</div>
);
