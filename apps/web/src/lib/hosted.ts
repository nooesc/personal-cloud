export const hosted = import.meta.env.VITE_PC_HOSTED === "true";
export type HostedSession = {
  mode: "hosted";
  user: { id: string; login: string; avatar_url: string };
  workspaces: { id: string; name: string; role: string }[];
  workspace: { id: string; name: string };
};
