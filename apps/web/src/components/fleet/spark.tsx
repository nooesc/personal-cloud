import { useId, useMemo } from "react";
import type { DitherColor } from "../dither-kit";
import { PALETTE, rgb } from "../dither-kit/palette";
import { hostCss } from "./palette";

const SPARK_W = 120;
const SPARK_H = 28;

/**
 * Stroke-only sparkline: y-range fit to the data (min→max with padding) so a
 * steady metric reads as a flat line, not a filled slab. Last point gets a dot.
 * Fills its container (`h-full w-full`); the parent sets the box.
 */
export const Spark = ({
	data,
	color,
}: {
	data: number[];
	color: DitherColor;
}) => {
	const glowId = useId();
	const { path, last } = useMemo(() => {
		const lo = Math.min(...data);
		const hi = Math.max(...data);
		const span = hi - lo || 1;
		const pad = 3;
		const step = SPARK_W / (data.length - 1);
		const pts = data.map((v, i) => [
			i * step,
			SPARK_H - pad - ((v - lo) / span) * (SPARK_H - pad * 2),
		]);
		return {
			path: pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(""),
			last: pts[pts.length - 1] ?? [0, 0],
		};
	}, [data]);
	const stroke = rgb(PALETTE[color].line);
	return (
		<svg
			viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
			preserveAspectRatio="none"
			className="h-full w-full overflow-visible"
			aria-hidden
		>
			<defs>
				<filter id={glowId} x="-10%" y="-50%" width="120%" height="200%">
					<feGaussianBlur stdDeviation="1.6" result="b" />
					<feMerge>
						<feMergeNode in="b" />
						<feMergeNode in="SourceGraphic" />
					</feMerge>
				</filter>
			</defs>
			<path
				d={path}
				fill="none"
				stroke={hostCss(color, 0.45)}
				strokeWidth={2.5}
				vectorEffect="non-scaling-stroke"
				filter={`url(#${glowId})`}
			/>
			<path
				d={path}
				fill="none"
				stroke={stroke}
				strokeWidth={1.25}
				strokeLinejoin="round"
				strokeLinecap="round"
				vectorEffect="non-scaling-stroke"
			/>
			<circle cx={last[0]} cy={last[1]} r={1.6} fill={stroke} />
		</svg>
	);
};
