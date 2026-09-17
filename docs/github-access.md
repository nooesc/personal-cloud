# GitHub sign-in and repository access

dinghy uses a GitHub App for two separate jobs: verifying the workspace owner's identity and granting access to selected source repositories. This remains a single-owner workspace. Installing the app on an organization does not let its members sign into the dashboard.

## First-time setup

1. Sign in with `PC_ADMIN_TOKEN` from `.env.production` and open **Settings → GitHub**.
2. Select **Register GitHub App**. Optionally enter an organization that should own the app registration. Your workspace needs a reachable public HTTPS URL. GitHub asks for a unique app name; the callback, webhook and permissions are preconfigured.
3. Select **Link my GitHub account** and authorize GitHub. This binds the numeric GitHub account ID to the existing owner; later username changes do not change ownership.
4. Select **Choose repositories**. Install on your personal account or an organization, choosing selected repositories or all repositories in GitHub. Repeat to connect more accounts. Organizations may require an administrator to approve the request.
5. Return to Settings and use **Refresh access** after approvals or permission changes. The project repository picker lists repositories visible to both your user and the installed app.

After linking, the sign-in dialog offers **Sign in with GitHub**. There is no first-visitor signup or implicit organization-member access. The owner token continues to work as a recovery credential.

## Permissions and deployment

The app requests **Contents: read**, **Metadata: read**, and push events. It does not request repository administration, code write, organization membership management, or GitHub Actions write access. The GitHub App webhook replaces per-repository webhook registration. Polling remains a fallback.

Private builds use a short-lived installation token limited to the source repository. Background deployments do not depend on the owner's browser session. User OAuth tokens are encrypted and refreshed server-side for account/repository discovery. App credentials, refresh tokens, and private keys never go to the browser.

Existing personal access token connections remain usable until the owner links the GitHub App. Once linked, repository access uses the app's verified installations and does not fall back to a saved PAT if access is denied. Previously configured public example repositories may need to be replaced by a repository on an account where you can install your app.

## Change or revoke access

**Manage** beside an account opens GitHub's installation settings. Add/remove repositories or uninstall there, then refresh access. Suspension/uninstall webhooks remove local grants; a new deployment also requests fresh provider authorization, so a revoked repository cannot use an old cached token.

**Owner recovery and reconnection → Reconnect GitHub** renews user authorization. To change the workspace's linked identity, enter the owner recovery token and select **Unlink GitHub sign-in**. This revokes GitHub-backed dashboard sessions and local source grants, without stopping deployed apps or deleting the GitHub App registration. Sign in with the recovery token, link the replacement identity, and reconnect repository access.

Back up the control database together with `PC_SECRET_KEY`. Encrypted GitHub configuration and credentials require that key for recovery.

## Security and verification

OAuth uses PKCE S256 and ten-minute, single-use state bound to an HttpOnly, SameSite=Lax flow cookie. Owner sessions remain HttpOnly and SameSite=Strict. Initial linking and app registration require an existing owner session; callbacks cannot claim ownership from a supplied username, email or installation ID. Installation callbacks verify access with the linked user's GitHub authorization before trusting an installation.

PostgreSQL-backed regressions cover browser binding, expired/replayed flows, cancelled authorization, wrong-account rejection, encryption, installation verification, per-repository token permissions, signed uninstall, recovery and session revocation. Mock provider responses verify the protocol; they do not establish that a real GitHub installation or private repository deployment has succeeded.

Implementation follows GitHub's [manifest registration](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), [user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), and [installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) protocols.
