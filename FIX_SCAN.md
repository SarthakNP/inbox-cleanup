# Fix a scan that stops after showing progress

The original message hid the underlying error. A likely trigger in large inboxes is that limiting concurrent requests does not limit how fast quota units are consumed. This update paces requests against Gmail’s new-project quota, handles rate limits with a shared cooldown, and shows a specific safe error code if another problem occurs. The exact cause of the previously failed scan is unconfirmed until your local app runs the update.

## Apply to your existing app

1. Stop the app in its terminal with **Ctrl+C**.
2. Put the supplied **apply-scan-fix.mjs** file inside your existing **inbox-cleanup** folder, beside `package.json`.
3. In a terminal opened in that same folder, run:

   ```bash
   node apply-scan-fix.mjs
   npm run dev
   ```

4. Reload `http://localhost:3000` and click **Scan inbox** once. Leave the app running while it scans. Large inboxes take longer because requests are now paced. A Gmail rate-limit pause resumes automatically; do not repeatedly restart the scan.
5. If the scan fails again, report the **new error banner**, including the diagnostic code in square brackets. You do not need to share credentials, tokens, email subjects, or the database.

If you normally run `npm start`, use this after applying the update instead:

```bash
npm run build
npm start
```

The updater changes only named source, test, and documentation files. It backs up old source files inside `.data/source-backups`. It does not read or overwrite `.env.local`, token-encryption keys, SQLite databases, your Gmail connection, protected senders, history, or Google Cloud settings. It makes no network requests. It checks for unexpected local edits before applying anything and refuses to overwrite them.

For a fresh installation, the updated complete `Inbox_Cleanup.zip` already contains the fix.

## What changes

- Gmail list requests cost 5 units; metadata reads and trash calls cost 20 units each under current new-project limits. The shared pacer uses a conservative 4,800-unit/minute budget (about four metadata checks per second), with at most five concurrent Gmail calls.
- A rate-limit response pauses queued work for at least 60 seconds and respects a longer `Retry-After`. The app displays the pause and automatically retries within its existing bounded attempt count.
- The final cleanup eligibility check runs after waiting for quota capacity and is repeated after a retry, immediately before calling Trash.
- Incomplete scans still disable cleanup. The new banner distinguishes rate limits, authorization expiry, permission/API configuration failures, connection failures, and local processing errors. It never dumps the raw Google error object, headers, tokens, message IDs, sender addresses, or subjects.

See [Google’s Gmail quota documentation](https://developers.google.com/workspace/gmail/api/reference/quota) for current limits.

## Verification

The updated application passes 28 automated tests, TypeScript checks, a production build, and the complete isolated localhost demo workflow. Tests use mocked Gmail responses, including rate limits and changed eligibility after a retry. No real messages were changed during development or testing. Real-account verification remains pending your local rerun.
