import { createFileRoute } from "@tanstack/react-router";
/** The workspace pages; the shell picks the page from the hash. */
export const Route = createFileRoute("/_shell/")({ component: () => null });
