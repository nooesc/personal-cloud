import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../lib/utils";
import { Collecting, HostSwatch, Reveal } from "./primitives";
import type { FleetHostView } from "./use-fleet";

/**
 * Shim for Dinghy's `@/components/dashboard/monitoring/free/container/show-free-container-monitoring`:
 * that component streams the Dinghy host's own docker stats over a WebSocket.
 * personal-cloud has no container-level stream, so the body says so instead of
 * fabricating one.
 */
const ContainerFreeMonitoring = (_props: {
	appName: string;
	hideHeader?: boolean;
}) => (
	<Collecting
		className="h-24"
		hint="container-level charts are not available for this host"
	/>
);

interface LocalDetailProps {
	host: FleetHostView;
	delay: number;
}

/**
 * The Dinghy host's own docker stats (the six live charts), tucked below the
 * fleet view. Collapsed by default: expanding mounts the component, which is
 * what opens its stats WebSocket.
 */
export const LocalDetail = ({ host, delay }: LocalDetailProps) => {
	const [expanded, setExpanded] = useState(false);
	const bodyId = useId();

	return (
		<Reveal delay={delay}>
			<section className="gh-surface rounded-lg">
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					aria-controls={bodyId}
					className={cn(
						"gh-interactive flex w-full items-center gap-3 px-4 py-3 text-left",
						expanded ? "rounded-t-lg" : "rounded-lg",
					)}
				>
					<ChevronRight
						className={cn(
							"size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
							expanded && "rotate-90",
						)}
						aria-hidden
					/>
					<HostSwatch host={host} />
					<span className="flex min-w-0 flex-col">
						<span className="gh-eyebrow">Local host · Docker detail</span>
						<span className="text-sm font-medium">
							{host.name} · container-level charts
						</span>
					</span>
					<span className="ml-auto hidden font-mono text-[11px] text-muted-foreground sm:block">
						cpu · memory · disk · block i/o · network
					</span>
				</button>
				{expanded && (
					<div id={bodyId} className="border-t border-border px-4 py-4">
						<ContainerFreeMonitoring appName="dokploy" hideHeader />
					</div>
				)}
			</section>
		</Reveal>
	);
};
