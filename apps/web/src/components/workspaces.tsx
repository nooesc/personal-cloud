import { useState } from "react";
import { Check, Plus } from "lucide-react";
import { api } from "../lib/data";
import type { HostedSession } from "../lib/hosted";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog } from "./ui/dialog";
import { Alert } from "./ui/misc";

export function WorkspacePicker({ session }: { session: HostedSession }) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(path: string, body: object) {
    setBusy(true);
    setError("");
    try {
      await api(path, body);
      // Tear down all old workspace subscriptions and cached entity selections together.
      window.history.replaceState(null, "", "/#page=Overview");
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return <>
    <div className="max-h-48 overflow-y-auto">
      {session.workspaces.map(workspace => <button key={workspace.id} type="button" role="menuitemradio"
        aria-checked={workspace.id === session.workspace.id} disabled={busy}
        className="gh-interactive flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left disabled:opacity-50"
        onClick={() => void change(`/workspaces/${encodeURIComponent(workspace.id)}/select`, {})}>
        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
        {workspace.id === session.workspace.id && <Check className="size-4 shrink-0" />}
      </button>)}
    </div>
    <button type="button" role="menuitem" className="gh-interactive flex h-8 items-center gap-2 rounded-md px-2 text-left" onClick={() => setCreating(true)}>
      <Plus className="size-4" /> Create workspace
    </button>
    {!creating && error && <Alert variant="destructive">{error}</Alert>}
    {creating && <Dialog title="Create workspace" onClose={() => !busy && setCreating(false)}>
      <form className="flex flex-col gap-4" onSubmit={event => {
        event.preventDefault();
        const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
        if (name) void change("/workspaces", { name });
      }}>
        <p className="text-sm text-muted-foreground">Each workspace has its own machines, projects, repository access and secrets.</p>
        <label className="flex flex-col gap-2 text-sm">Workspace name<Input autoFocus name="name" required maxLength={80} placeholder="My cloud" /></label>
        {error && <Alert variant="destructive">{error}</Alert>}
        <Button type="submit" isLoading={busy}>Create workspace</Button>
      </form>
    </Dialog>}
  </>;
}
