import { createFileRoute } from "@tanstack/react-router";
import { PROJECT_TABS, type ProjectTab } from "../components/project";
/** One project's page; the shell renders it from the workspace snapshot. */
export const Route = createFileRoute("/_shell/projects/$projectId")({
  validateSearch: (search: Record<string, unknown>): { tab?: ProjectTab; service?: string } => ({
    tab: PROJECT_TABS.includes(search.tab as ProjectTab) ? (search.tab as ProjectTab) : undefined,
    service: typeof search.service === "string" && search.service ? search.service : undefined,
  }),
  component: () => null,
});
