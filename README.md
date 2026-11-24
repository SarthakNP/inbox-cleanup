# Inbox Cleanup

A personal, localhost-only Gmail cleanup app. Review **inbox Promotions** by exact sender address, select messages, confirm the exact batch, and move individual messages to Gmail Trash.

Next.js App Router + TypeScript + Tailwind CSS, Google's official Node.js API client, and local SQLite. There is no separate backend, external database, AI service, or analytics integration.

## Start with the demo

Install **Node.js 24 or newer** (Node 24 LTS recommended). This app uses the built-in `node:sqlite` module; no database service or native SQLite package installation is needed. An experimental SQLite notice on some Node versions is expected.

Extract this project, open a terminal in `inbox-cleanup`, and run:

```bash
npm ci
npm run dev
```

Open **http://localhost:3000**, then click **Try demo mode**. You do not need Google credentials or an encryption key for the demo. Both development and production launch commands bind to `localhost`, with port `3000` explicitly set. Stop with Ctrl+C. Do not run multiple server instances against the same database.

The demo is labeled throughout and uses a separate data scope. Its sample inbox contains high-volume senders, read and unread mail, two distinct sender addresses at the same brand/domain, a receipt from a promotional sender, a starred promotion, an archived promotion, and an initially protected sender. The receipt, starred promotion, and archived promotion never appear among eligible messages. Demo data and cleanup history persist between visits; leaving demo mode does not erase it.

## Configure the real Gmail connection

Enter credentials **only in your own local `.env.local` file**. Never paste credentials or tokens into chat or commit them.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project named `Inbox Cleanup` (or select your own project).
2. In **APIs & Services → Library**, find **Gmail API** and enable it for this project.
3. Open **Google Auth Platform** (also accessible through **APIs & Services → OAuth consent screen**). Initialize the consent configuration if prompted. Under **Branding**, set the app name, user support email, and developer contact email.
4. Under **Audience**, choose **External** for a personal Gmail account. Keep the app in **Testing** and add the exact Gmail address you will connect under **Test users**. An organization's Internal option only works for eligible accounts in that organization.
5. Under **Data Access**, add this one scope:

   ```text
   https://www.googleapis.com/auth/gmail.modify
   ```

   Do not add `https://mail.google.com/`. The application requests only `gmail.modify`; Google describes that scope broadly, but the code implements only metadata reads and moving selected individual messages to Trash.

6. Under **Clients → Create client**, select **Web application** (not Desktop app). Give it a name such as `Inbox Cleanup localhost`. Add the authorized JavaScript origin `http://localhost:3000` if the form asks for one. Under **Authorized redirect URIs**, add **exactly**:

   ```text
   http://localhost:3000/api/auth/google/callback
   ```

   Do not add a trailing slash. The browser must use `localhost`, not `127.0.0.1`.

7. Copy the Web client's **Client ID** and **Client secret** into your local file:

   ```bash
   cp .env.example .env.local
   npm run keygen
   ```

   `keygen` prints a freshly generated 64-character hexadecimal key. Paste that entire key into `TOKEN_ENCRYPTION_KEY`. Keep this key stable while an account is connected.

   ```dotenv
   GOOGLE_CLIENT_ID=your-actual-web-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-actual-client-secret
   APP_ORIGIN=http://localhost:3000
   TOKEN_ENCRYPTION_KEY=your-generated-64-character-hex-key
   NEXT_TELEMETRY_DISABLED=1
   ```

8. Restart the server after editing `.env.local`. Exit demo mode if necessary. Click **Connect Gmail**, choose your test-user account, and grant the requested Gmail permission. Your email address will appear in the header. Click **Scan inbox** to start a real metadata scan. Connecting and scanning do not modify email.

Google's setup references: [Gmail Node.js quickstart](https://developers.google.com/workspace/gmail/api/quickstart/nodejs), [consent and test users](https://developers.google.com/workspace/guides/configure-oauth-consent), and [web server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server). Use the **Web application** client described above; this app implements server-side authorization-code OAuth rather than the quickstart's desktop authentication.

## Use the app

1. Complete a scan. Progress first counts pages and candidates, then metadata checks. Exact counts are shown only after every candidate page and metadata request is finished. A partial failure marks the scan incomplete and disables cleanup.
2. Search by sender name/address and choose the age/minimum filters. Age uses Gmail's `internalDate` receipt time, not the email's Date header. “Older than 1 year” means 365 days. Age is applied before sender counts and minimum thresholds. Top cards reflect the current filters. **Changing any filter clears the selection.**
3. Select sender checkboxes to select their matching messages. Expand a row to review ten messages per page and deselect individual emails. A partly selected sender gets an indeterminate checkbox. The table header checkbox covers the visible sender page; **Select all results** explicitly covers every matching message on every page and shows the exact scope/count.
4. **Keep this sender** protects only that exact normalized address, immediately removes its selected messages, and saves the preference locally. Use **Protected senders** to remove protection. This does not create Gmail filters or change Gmail settings.
5. Click **Move to Trash**. The server freezes the exact IDs and age cutoff, and the dialog shows the message count, sender count, and each sender's count. Cancel leaves Gmail unchanged. Confirmations expire after 15 minutes, are single-use, and are invalidated by a new scan or another prepared batch.
6. Confirm explicitly inside the website. The server fetches fresh metadata for every individual selected ID and checks inbox, Promotions, no star, exact sender, protection, and the frozen age condition before calling `messages.trash`. New arrivals never enter the frozen batch. Full bodies and attachments are never requested. Receipts and other non-Promotions from the same sender are excluded.
7. Watch the separate **success**, **skipped**, and **failed** counts. The dashboard scans again after processing. **Review failed & retry** prepares only unprotected failed IDs and requires another confirmation. Successfully moved or skipped IDs do not join a retry. History keeps each batch and retry separately.

There are no automatic selections, scheduled cleanups, unsubscribe actions, archive actions, mark-as-read actions, or permanent-delete endpoints. This app does not empty Gmail Trash. Manage restoration or other Trash behavior directly in Gmail.

## Commands and checks

```bash
npm ci                 # install locked dependencies
npm run dev            # localhost:3000, development
npm test               # mocked Gmail / API / safety tests; no real email
npm run test:watch     # watch those tests
npm run typecheck      # TypeScript checks
npm run build          # optimized production build
npm run test:demo      # live HTTP demo smoke test; build first
npm start              # localhost:3000, production build
npm run keygen         # generate the token-encryption key locally
```

The test suite covers all eight requested scenarios: archived/starred exclusion, read/unread eligibility, receipt safety, more than 500 results and deduplication, filtered selections/deselection, protected senders, changed eligibility, and partial failure/retry outcomes. It also checks CSRF/host enforcement, one-time OAuth state + PKCE, encrypted token persistence, refreshed credentials, exact API parameters, backoff, and concurrency capped at five Gmail calls.

`test:demo` starts the built app at `http://localhost:3089` in an isolated temporary directory with Google credentials explicitly disabled. It exercises a full multi-page scan, sender selection and individual deselection, cancelled and confirmed batches, duplicate blocking, exact count updates, protection, saved history, and exit/reentry. It stops the server and removes its temporary sample data afterward. Port 3089 must be available. It never uses your normal database or real Gmail account.

The included [VALIDATION.md](VALIDATION.md) records what was verified and the remaining real-account/browser checks.

## Local data and security

- `.data/inbox-cleanup.sqlite` stores encrypted OAuth tokens, sessions, account details, settings, protected senders, batch IDs/sender counts, and per-message batch outcomes. Sample messages are stored separately for demo mode. Real message subjects are kept only in the process's scan memory and sent to this app's browser UI.
- `TOKEN_ENCRYPTION_KEY` is a 32-byte key used for AES-256-GCM authenticated encryption. It stays on the server, as do Client ID, Client secret, access tokens, and refresh tokens. No tokens are placed in URLs, browser storage, or logs. The OAuth authorization code and one-time state use the standard server callback; they are not tokens.
- Sessions use an HTTP-only SameSite=Lax cookie containing an opaque random ID (only its hash is persisted). Local HTTP uses a non-Secure cookie deliberately; this application is for `localhost` only. The server checks Host, exact Origin, JSON content type, and a per-session CSRF header on mutations. React escapes names/subjects. Responses disable caching and framing.
- All requested IDs are checked against the connected account's complete eligible scan and filters. Batches, settings, history, and protection are scoped to the real account or demo. No Gmail filters/settings or thread-level operations are used.
- At most five Gmail calls run concurrently in this single Node process. A shared, weighted pacer spreads list (5 units), metadata (20 units), and trash (20 units) calls across time with a 4,800-unit/minute budget, below Google’s 6,000-unit user limit for new projects. A metadata scan therefore checks roughly four messages per second. Gmail rate limits pause all queued work for at least one minute (or longer when Retry-After requests it), then retry within the original bounded attempt count. Transient failures use bounded exponential backoff. Cleanup reserves the fresh metadata recheck and trash call together, and repeats the recheck after a retry, so a quota wait cannot separate eligibility validation from Trash. Non-rate-limit permission failures do not get automatically retried. Revoked/expired authorization is surfaced for reconnection; it never falls back to demo.
- Individual outcomes are persisted as they finish. If the server stops mid-batch, pending/uncertain items are recorded as failed on restart. Rescan, review, and explicitly retry; a retry first rechecks eligibility and skips anything already outside the inbox. It never automatically resumes destructive work.
- **Disconnect** revokes the refresh token with Google and clears the real account's local sessions, settings, history, protection, credentials, and scan. Already revoked grants are treated as disconnected. If Google cannot be reached to confirm revocation, the app retains the connection and explains how to retry. **Exit demo** only exits the demo session and never touches a real grant.
- `.env.local`, `.data`, SQLite files, logs, and build artifacts are ignored by Git and excluded from the delivered source archive. Keep `.env.local` and the data directory private. `DATA_DIR` can optionally point to another private local directory. Runtime commands disable Next.js telemetry; the interface uses no remote fonts, analytics, or AI services.
- Run one local server process. This version is intentionally not configured for public hosting, serverless background work, multiple replicas, or multiple Gmail accounts.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `redirect_uri_mismatch` | Open the Google **Web application** client's redirect list. Match `http://localhost:3000/api/auth/google/callback` exactly, including protocol, hostname, port, and path. Restart after changing `.env.local`. Open the app with `localhost`, not `127.0.0.1`. |
| Gmail isn't configured / connect returns an error | Replace the placeholder Client ID, Client secret, and encryption key in `.env.local`, then restart. Demo remains available only through the labeled demo button. |
| Access denied or missing Gmail permissions | Enable Gmail API in the same Cloud project as the OAuth client. Add the exact account as a test user and configure `gmail.modify` in Data Access. Reconnect and grant that permission. Workspace administrators may restrict the application. |
| Expired or revoked authorization / `invalid_grant` | Use **Reconnect Gmail**, grant permission again, then run a fresh scan. For external apps in Google's Testing mode, refresh tokens for Gmail access can expire after seven days. Revocation, password changes, or account policies can also require reconnection. See [Google token-expiration guidance](https://developers.google.com/identity/protocols/oauth2#expiration). |
| Google does not return offline access | Remove the app under your [Google account connections](https://myaccount.google.com/connections), then connect again. The application requests offline access and consent; it needs a refresh token. |
| Counts show a dash / scan incomplete | The updated banner includes a safe diagnostic code, scan stage, and HTTP status/provider reason when available. `GMAIL_RATE_LIMIT` means wait at least one minute and retry; `GMAIL_PERMISSION_DENIED` means check permissions; `GMAIL_AUTH_EXPIRED` means reconnect. Cleanup stays disabled until the full scan succeeds. Counts never substitute Gmail's estimate for exact retrieved messages. |
| Rate limit / some messages fail | Wait, refresh or reconnect as appropriate, then use **Review failed & retry**. Automatic retries are bounded. Every new cleanup attempt still requires confirmation. |
| Localhost verification error | Use `http://localhost:3000` with `APP_ORIGIN=http://localhost:3000`. Do not use a public proxy, alternate hostname, or browser URL at `127.0.0.1`. |
| Port 3000 is in use | Stop the other process. The launch commands explicitly use port 3000 so the callback cannot silently move to another port. |
| `node:sqlite` unavailable | Upgrade to Node.js 24+, run `npm ci`, and restart. |
| Encryption key lost or changed | Restore the original key. If it cannot be recovered, revoke the app from Google account connections, stop this server, remove the local `.data` directory (or configured DATA_DIR) yourself, generate a new key, and reconnect. This resets local history/protection/preferences. |
| Server restarted during cleanup | The history shows uncertain items as failed with an explanatory reason. Complete a new scan, then review failed messages and confirm a retry. Already trashed messages will be skipped after their fresh metadata check. |

## Source map

```text
src/app/api/[...action]/route.ts           Local API and mutation/CSRF handling
src/app/api/auth/google/callback/route.ts  Authorization-code OAuth callback
src/components/inbox-app.tsx              Connection screen and cleanup interface
src/lib/domain.ts                         Shared eligibility/filter/selection rules
src/lib/engine.ts                         Pagination, bounded work, rechecks, outcomes
src/lib/gmail.ts                          Official Gmail API adapter and token refresh
src/lib/security.ts                       Sessions, CSRF, encryption, localhost policy
src/lib/db.ts                            SQLite schema and local persistence
src/lib/service.ts                        Scan state and frozen cleanup batches
src/lib/demo.ts                           Isolated sample mailbox
tests/                                   Mocked safety and API tests
scripts/demo-smoke.mjs                    Built-app localhost demo workflow check
```

## Updating an existing installation after a failed scan

See [FIX_SCAN.md](FIX_SCAN.md). The included `apply-scan-fix.mjs` installs the quota-pacing and diagnostic fix in an existing copy of this app, backing up changed source files first. It never opens your SQLite database or changes `.env.local`, your encryption key, Gmail authorization, or Google Cloud settings.

Quota reference: [Gmail API usage limits](https://developers.google.com/workspace/gmail/api/reference/quota). Exact limits depend on the Google project; the conservative budget works for the current new-project limits.
