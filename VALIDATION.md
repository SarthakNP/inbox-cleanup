# Validation record

Validated November 22, 2026, using Node.js 24.22.3, Next.js 16.4.6, and a fresh local sample mailbox. No real Gmail account was connected or modified.

| Check | Result |
| --- | --- |
| `npm test` | 28 tests passed across 4 files, using mocked Gmail/API responses and temporary SQLite databases |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; optimized Next.js application with server-side API routes |
| `npm run test:demo` | Passed against the built application running on localhost with Google credentials removed |
| `npm audit --omit=dev --audit-level=high` | No production dependency vulnerabilities reported at verification time |
| Real Gmail OAuth and real mailbox scan | Pending your local Google credentials |
| Interactive browser rendering / click-through | Unverified in this environment: its preview launcher supplied Vite-specific options to Next.js. The application was verified through its running localhost HTTP interface instead. |

## Required safety scenarios

| Requirement | Automated evidence |
| --- | --- |
| Archived and starred messages never eligible | Domain/scan tests, server batch validation, and live demo assertions |
| Both read and unread Promotions eligible | Scan/cleanup tests explicitly exercise both |
| Same-sender non-Promotions receipt untouched | Mocked scan + cleanup leaves receipt unchanged; live endpoint rejects its ID |
| More than 500 results | Engine retrieves 1,203 unique metadata records over 3 pages, including deduplication; official-client adapter retrieves 501 records over 2 pages |
| Filters and individual deselection select correct IDs | Age/search/minimum-count tests and shared selection functions; live test selects 286 sender messages and excludes one |
| Protected senders cannot enter a new batch | Service/API validation rejects protected IDs; protection persists and affects exact addresses only |
| Changed eligibility checked immediately before trash | Recheck tests change inbox/category/star/protection/receipt time; a frozen live-service batch skips a newly protected sender |
| Partial failures and retry correctness | Separate success/skipped/failed outcomes; retry validates failed IDs only and preserves original age cutoff |

Additional checks cover at most five concurrent Gmail calls, rate-limit backoff, no retries for permanent permission failures, incomplete scans, exact metadata/list/trash API parameters, CSRF and localhost policy, one-time OAuth state with PKCE, encrypted refresh/access token storage, refresh events, expired authorization, and disconnect revocation/data clearing. Revocation is tested to use a POST form body so the token is not added to a URL.

The live demo check exercises connect-to-demo, complete scan, group selection, individual deselection, invalid receipt selection, cancellation, explicit confirmation, duplicate execution rejection, exactly 285 sample successes, updated counts, protection/unprotection, saved history, and exit/reentry. It uses an ephemeral database and disables Google credentials.

## Test the interface locally

1. Run `npm ci` and `npm run dev`, open `http://localhost:3000`, and choose **Try demo mode**.
2. Verify the **DEMO MODE** label, empty initial selection, and ten eligible unprotected sender groups. The exact-address VIP sender remains separate from the other Nord & Co. address.
3. Expand Nord & Co., select that sender, deselect one message, and observe the indeterminate sender checkbox and exact selection count. Navigate individual-message pages.
4. Change the age or minimum filter and verify selection clears. Try sender search. The top counts and table reflect the current filters. Reset to All ages / 1 email.
5. Click **Keep this sender** on a selected sender. Its messages leave the selection and table. Remove it through **Protected senders** and check it returns without selecting anything.
6. Select a sender, open **Move to Trash**, check the exact per-sender counts, and cancel. Open it again and confirm. Check separate outcomes, refreshed totals, and **Cleanup history**.
7. Use **Select all results** to inspect its explicit all-pages scope, then **Clear selection**. No cleanup runs without confirmation.
8. Once configured, use **Connect Gmail** and **Scan inbox** to verify real OAuth, the connected address, scan progress, and exact counts. Merely connecting/scanning leaves real email unchanged. Only confirm a real cleanup batch when you personally intend to move those messages to Trash.

Partial API failure and changed-eligibility scenarios are deliberately injected in automated tests, rather than simulated by secretly changing real Gmail messages or adding extra demo controls.

## Scan failure follow-up

A real-account user reported a scan that showed progress and then failed with the original generic banner. The exact provider error was hidden by the old catch handler and remains unconfirmed. Code review found that concurrency limiting did not enforce Gmail’s time-based quota. The update adds a weighted quota pacer using current new-project quotas, shared cooldown and Retry-After handling, clear redacted diagnostics, and an on-screen retry countdown. Cleanup rechecks eligibility again after any quota wait or retry.

Eight additional regression tests cover weighted request spacing, a 501-message scan within the minute budget, shared pause/resume without a burst, Retry-After and quota reason recognition, private-data redaction, adapter retry recovery, incomplete scan diagnostics, and a new eligibility check before retried Trash requests. Mocked tests, TypeScript, build, and the complete isolated localhost demo were rerun. Real-account verification remains with the user’s local installation.
