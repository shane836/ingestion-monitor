# Maintainer notes and open items

These notes support the [Data Pipeline Monitor portfolio case study](README.md).
The selected runtime is the owner's Mac. Checks pause during sleep or shutdown;
continuous uptime coverage is not required.

## Current runtime — 2026-11-03 UTC

- The native user launchd service `com.masonequity.ingestion-monitor` is running
  on `127.0.0.1:8080`. It starts at login and restarts after failure.
- The previous Docker instance is stopped. Its incident state was copied into
  ignored `state/incidents.json`; its named volume remains available as a backup.
- Local health returned `ok: true`; unauthenticated status requests returned 401.
- Distinct local admin/project tokens are stored in ignored `.env`. CRE Radar's
  session confirmed matching token configuration and
  `CRE_MONITOR_URL=http://127.0.0.1:8080` in its own ignored `.env`.
- The last completed live cycle passed SF Events' API/browser checks and reported
  four failed ingestion jobs: Eventbrite, Independent, Spark Social, Ticketmaster
  (GitHub run `41520861510`). CRE's page checks passed; its heartbeat was missing.
- All 16 regression tests pass. Source-code processing by OpenAI was approved.
  A live diagnosis-only Codex test passed; a separate fixture patch passed real
  fresh-checkout validation and disposable PostgreSQL startup/cleanup.
- **Automatic local repair is enabled.** Shane explicitly approved activation
  and a full end-to-end cycle on 2026-11-03 UTC. The native service was restarted
  with `repair.enabled=true`. Both projects completed with diagnosis-only reviews
  and one automatic attempt each. Restarting and repeating the cycle retained the
  same receipts/counts and launched no duplicate attempts.
- SF Events initially lacked logs inside the agent sandbox. Host-side evidence
  collection was added and tested; a deliberate manual retest supplied filtered
  failure logs and completed successfully. It reported HTTP 405 access failures
  for Eventbrite/Spark Social and identity conflicts for Independent/Ticketmaster.
  No patch was justified; these require human review.
- Heartbeat transport was verified on 2026-11-03 at 09:42 UTC with empty HTTP 204.
  The existing sender replayed 20 source outcomes recorded at 2026-11-02 15:00:45
  UTC. Overall status was partial because the recorded job failed to write its
  Obsidian digest note. This was not a new successful ingestion. No source or
  database code change was needed: the sender was installed after the last run.
- Local email notifications are enabled using CRE Radar's existing Resend key,
  verified sender address, and one private digest recipient. Values were copied
  through local file operations into ignored `.env`, without displaying them.
  Resend accepted message `01a1a0cc-a2f8-7007-91bd-38e872df5f3e`; repeating the
  notification request returned the same receipt. The sending key cannot retrieve
  delivery events. A separate test through the same Resend configuration was
  confirmed in the connected recipient Outlook mailbox at 2026-11-03 09:50:25 UTC.
  Exact subject, unique body code, sender, and received timestamp matched.
  Receipt and marker: ignored `state/delivery-check.json`.
  No application commit or deployment has occurred.

## Operate the native service

Use `npm run install:local` for a new installation after preparing `.env` and
installing Chromium. It refuses to overwrite a different installation.
The plist lives under `~/Library/LaunchAgents/`; logs are `state/service.log`
and `state/service-error.log`. The service's working directory is this repository.
A Node upgrade that removes its installed binary may require reinstalling the
launch agent. The installer records the Node executable used at installation.

Restart the existing service after configuration or source changes:

```sh
launchctl kickstart -k gui/$(id -u)/com.masonequity.ingestion-monitor
```

To stop it without deleting state:

```sh
launchctl bootout gui/$(id -u)/com.masonequity.ingestion-monitor
```

Start a stopped, installed service:

```sh
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.masonequity.ingestion-monitor.plist"
```

Do not run `npm start` or Docker Compose while the native service owns port 8080.
Docker is needed only for SF repair validation's disposable PostgreSQL database.

## Configuration and endpoints

`projects.json` defines checks and repository-specific repair installation,
validation commands, and allowed paths. `repair.enabled` controls automatic
attempts. The manual `npm run repair` command is independent of that flag and the
scheduler's cooldown. Automatic local repair is now enabled by owner approval.

`CODEX_BIN` optionally selects the installed executable rather than a shell alias.
The default `codex` is resolved from PATH. `gh auth login` and `codex login` supply
local repository/model access. No GitHub Actions secrets are needed. An optional
read-only `GITHUB_TOKEN` supports workflow checks; no Contents write is required.
Never paste or commit credentials.

| Endpoint | Purpose | Authorization |
|---|---|---|
| `GET /health` | Monitor process health | Public on localhost |
| `GET /status` | Saved checks, incidents, and local review results | `MONITOR_API_TOKEN` |
| `POST /run` | One cycle; rejects overlap, can wait for a repair | `MONITOR_API_TOKEN` |
| `POST /notify` | Email current status if changed; no new repair attempt | `MONITOR_API_TOKEN` |
| `POST /heartbeats/cre-radar` | Store CRE pipeline result | `CRE_HEARTBEAT_TOKEN` |

Send tokens as Bearer headers. A valid heartbeat returns empty HTTP 204.
The receiver accepts `completed`, `partial`, or `failed` overall and per-source
statuses. Overall `completed` is rejected if any supplied source did not complete.
Limits are 64 KiB, 200 source entries, and 200 characters per source name.
Heartbeats are timestamped by the receiver and evaluated during the next cycle.
Zero records can be a successful source outcome.

## Acceptance checks

- [x] **L01 — Live model test.** Source-code processing was approved. A live
  Codex attempt at commit `5601f0ea7e9dcce932f2cbf849efdf34a404ca9f` returned valid
  structured output and an empty patch for the synthetic no-defect incident.
  Receipt: `review/2026-11-03T08-46-37.839Z-controlled-test-52264a04-67b2-422e-9523-f7d1425a5627/result.json`.
- [x] **L02 — Patch-path acceptance.** A fixture patch passed real fresh-checkout
  application and validation; a disposable PostgreSQL container started and was
  removed successfully. The first context-free fixture patch was correctly
  rejected; a git-generated unified diff passed. No application defect or
  model-generated fix is claimed. Receipt:
  `review/2026-11-03T08-48-46.909Z-patch-acceptance-00e25213-e104-487c-b121-c2d28373f1e5/result.json`.
- [x] **L03 — Local email.** Incident/review changes and recovery trigger one
  private Resend email. Errors persist at `_notification.error` and retry on a
  later cycle or `npm run email:test`; no repair rerun is needed. Successful
  receipts are persisted to suppress duplicates. A separate unique test message
  was found in the connected recipient Outlook mailbox, confirming delivery.
- [ ] **L04 — Next scheduled CRE delivery.** Transport is verified with the
  existing sender and a partial historical-run report. Observe fresh results from
  the next existing launchd run. No ingestion was run merely to test transport.
- [x] **L05 — Automatic local attempts.** Explicitly approved and activated. Both
  project reviews were saved. Restart/repeat testing preserved each automatic
  attempt count at one. The seven-day unchanged-incident cooldown remains
  configured; a seven-day expiry was not exercised in this live test. Unit tests
  cover immediate deduplication and recovery rearming. Failed local attempts
  consume the same configured cooldown.
- [ ] **L06 — Recovery operations.** Verify state after login/restart and extended
  sleep; define disk cleanup for review checkouts and logs. No artifact expiry
  or independent uptime watchdog is configured for this local setup.

The owner applies reviewed patches manually after confirming their base is still
current and rerunning checks. Local repair does not commit, push, merge, deploy,
write production data, or send application/newsletter messages. Private monitor email is sent by the
parent service; email credentials are excluded from repair children. Dependencies and validation execute as
the local user with a clean environment; this is not a machine-isolated runner.

## Live review receipts

- SF Events automatic review: `review/2026-11-03T08-52-21.181Z-sf-events-2531b1e8-115f-44ca-87c0-b14067a3d0b0/result.json`.
- SF Events manual retest with failure evidence: `review/2026-11-03T08-56-03.870Z-sf-events-a32e87fc-a753-4063-a845-5aa9297edae6/diagnosis.txt`.
- CRE Radar automatic review: `review/2026-11-03T08-53-45.629Z-cre-radar-b3570804-d6df-483f-91cc-af55bfb63c8a/diagnosis.txt`.

The manual retest does not replace the original automatic receipt in `/status`;
both remain available on disk. Application issues remain open despite successful
monitor-to-review execution. Local email was subsequently tested as recorded above;
inbox delivery was confirmed through the connected Outlook mailbox.

## Local email settings

Set `MONITOR_EMAIL_ENABLED=true`, `RESEND_API_KEY`, `MONITOR_EMAIL_FROM`, and
`MONITOR_EMAIL_TO` in the ignored `.env`. The recipient must be one private
address. `npm run email:test` requests a status email without running Codex.
Repeated unchanged state returns the existing receipt rather than sending again.
The transport follows [Resend’s send-email API](https://resend.com/docs/api-reference/emails/send-email).
