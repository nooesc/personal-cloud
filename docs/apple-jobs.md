# Native Apple jobs

The hosted edition schedules native iOS Simulator builds and tests through the same Nomad cluster as Linux fleet workloads. A Mac must be a registered, ready, eligible Nomad client with a healthy raw_exec driver and Apple helper metadata. Xcode inventory alone never establishes readiness.

## Setup

Install and select full Xcode, finish its first-launch setup, and install an iOS Simulator runtime. Run the agent as a non-root macOS user with:

```sh
personal-cloud-agent --api https://your-dinghy-host --state /absolute/path/agent.json \
  --apple-jobs --apple-work-dir /absolute/path/apple-jobs
```

Keep the existing enrolled identity. Install a checksum-verified Nomad binary matching the cluster and use `scripts/install-macos-nomad.py` with the private server RPC endpoint, Mac advertise address, binary paths, identity file, and work directory. The script installs a non-root client-only LaunchAgent and enables only the native raw_exec driver. It records helper paths in Nomad node metadata. It never bootstraps another cluster. Set the monitoring LaunchAgent's `PC_NOMAD_DATA_DIR` to the installed Nomad data directory (`~/.dinghy/nomad`) so inventory includes its node identity.

Nomad RPC must be reachable over a private network. A Tailscale-backed server may use a separate Nomad configuration overlay for its RPC listen/advertise address and an explicit firewall rule for enrolled client IPs; preserve the existing HTTP, WireGuard and Docker configuration. Do not expose RPC to the public Internet. The Mac helper does not need the server's management token.

Restart the monitoring agent after changing Xcode or simulator runtimes. Simulator jobs require a suitable logged-in macOS user environment; this does not promise unattended operation before login or after a reboot.

In a linked repository's **Apple jobs** tab, choose the Mac and simulator, provide the full commit SHA, repository-relative `.xcodeproj` or `.xcworkspace`, shared scheme, and build/test action. GitHub access is checked when queued and again when claimed. Installation tokens are scoped to repository contents, passed only to Git fetch, and never persisted in job records or Git remotes.

## Execution and results

Dinghy submits an immutable Nomad batch job pinned to the selected Mac's node ID and Darwin OS. Nomad owns placement, resources, execution and cancellation. Restart and reschedule policies disable automatic retry/relocation. Each Apple group reserves host port 49999 as a scheduling slot (no listener is created), so Nomad allows one Apple allocation per Mac while other native services can use remaining resources.

The agent no longer polls or claims Apple work. Nomad invokes its one-shot `--apple-run` helper. Before releasing a short-lived GitHub source token, Dinghy verifies that the actual Nomad allocation belongs to that job and node and is running. The task uses a detached exact-commit checkout, separate DerivedData, and a temporary simulator clone. Signing is disabled. The simulator is removed afterward; recorded abandoned simulators are retried before the next Apple task.

Cancellation stops the Nomad job and waits for allocation termination. The helper handles interrupt/termination and kills its subprocess group. Lost control-plane contact cancels execution. A posted build result is provisional: job completion follows observed Nomad allocation completion, never just a worker acknowledgement. Failed/lost allocations stay failed/interrupted. Legacy direct-queue jobs become interrupted during migration and require explicit resubmission; their existing history/artifacts remain available.

Completed jobs expose the last approximately 60 KB of logs and a private ZIP containing the log and `.xcresult` bundle when generated. Xcode test attachments can include screenshots. ZIP upload is capped at 100 MiB; larger results remain on the Mac and the job log reports that limitation. Logs appear after completion, not as a live stream. Successful result acknowledgement removes checkout and DerivedData; local result files remain under the work directory for recovery and currently require manual retention management. Hosted result retention is also manual.

## Trust and current boundary

Repository scripts execute as the worker's macOS user. Use a dedicated account and only trusted repositories; this is not an isolation boundary for arbitrary customer code. Each customer supplies their own Mac and enrolled machine credential. There is no shared public Mac pool.

This first version supports unsigned iOS Simulator builds/tests. Signing identities, provisioning profiles, archives, TestFlight, physical-device QA, macOS application tests, dependency bootstrap scripts, and private submodule/package credentials are not configured automatically. A failed build remains failed even if the machine itself is ready.

## Verification

`pnpm check:cloud` includes Nomad specification, allocation authorization and result-fencing tests and a real local workerd SQLite/R2 test with synthetic GitHub and scheduler providers. `python3 apps/control-cloud/test/hosted-local.py` checks the hosted API boundary. A real Mac can exercise the native Xcode execution path against a disposable project:

```sh
PC_APPLE_SMOKE_SOURCE=/absolute/path/disposable-fixture \
  cargo test -p personal-cloud-agent simulator_build_and_test -- --ignored
```

The fixture must contain `AppleSmoke.xcodeproj`, a shared `AppleSmoke` scheme with a test target, and an empty `output` directory. It runs actual Simulator tests and checks that the result bundle exists and the temporary simulator record is removed. Synthetic provider tests do not prove a production GitHub build.
