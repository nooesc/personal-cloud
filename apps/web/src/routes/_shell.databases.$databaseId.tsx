import { createFileRoute } from "@tanstack/react-router";
/** One database's page; the shell renders it from the workspace snapshot. */
export const Route = createFileRoute("/_shell/databases/$databaseId")({
  component: () => null,
});
