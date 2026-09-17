import { useEffect, useState } from "react";

/**
 * Dinghy's header clock. Dinghy ticks from `server.getServerTime`; here the
 * anchor is the last snapshot's `generated_at` (server-stamped), advanced one
 * second at a time in the browser. Rendered in the browser's zone since the
 * control plane does not publish its own. Renders nothing without an anchor.
 */
export function TimeBadge({ anchor }: { anchor: string | null }) {
	const [time, setTime] = useState<Date | null>(null);
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	useEffect(() => {
		if (anchor) {
			setTime(new Date(anchor));
		}
	}, [anchor]);

	useEffect(() => {
		const timer = setInterval(() => {
			setTime((prevTime) => {
				if (!prevTime) return null;
				const newTime = new Date(prevTime.getTime() + 1000);
				return newTime;
			});
		}, 1000);

		return () => {
			clearInterval(timer);
		};
	}, []);

	if (!time || !anchor || !timezone) {
		return null;
	}

	const getUtcOffset = (timeZone: string) => {
		const date = new Date();
		const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
		const tzDate = new Date(date.toLocaleString("en-US", { timeZone }));
		const offset = (tzDate.getTime() - utcDate.getTime()) / (1000 * 60 * 60);
		const sign = offset >= 0 ? "+" : "-";
		const hours = Math.floor(Math.abs(offset));
		const minutes = (Math.abs(offset) * 60) % 60;
		return `UTC${sign}${hours.toString().padStart(2, "0")}:${minutes
			.toString()
			.padStart(2, "0")}`;
	};

	const formattedTime = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		timeStyle: "medium",
		hour12: false,
	}).format(time);

	return (
		<div className="inline-flex items-center rounded-full border p-1 text-xs whitespace-nowrap max-w-full overflow-hidden gap-1">
			<div className="inline-flex items-center px-1 gap-1">
				<span className="hidden sm:inline">Server Time:</span>
				<span className="font-medium tabular-nums">{formattedTime}</span>
			</div>
			<span className="hidden sm:inline text-primary/70 border rounded-full bg-foreground/5 px-1.5 py-0.5">
				{timezone} | {getUtcOffset(timezone)}
			</span>
		</div>
	);
}
