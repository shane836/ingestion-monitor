# Monitoring open items

Updated 2026-10-24. Source code is published privately at
[shane836/ingestion-monitor](https://github.com/shane836/ingestion-monitor).
The Docker image and eight tests pass. The service is **not deployed** and repair
dispatch is **disabled**. No agent review email has been sent.

## Required before activation

- [ ] **M01 — Choose and deploy the host.** Run one Docker service on an always-on
  host separate from the Mac running CRE Radar. Mount persistent incident state,
  configure HTTPS, and verify state survives a container restart.
- [ ] **M02 — Configure service authentication.** Populate the ignored `.env` with
  distinct `MONITOR_API_TOKEN` and `CRE_HEARTBEAT_TOKEN` values. Verify unauthorized
  requests fail and project tokens cannot access another project's endpoints.
- [ ] **M03 — Configure GitHub access.** Give the service token Actions write on
  this repository and Actions read / Contents read on the monitored repositories.
  Add read-only `MONITOR_GITHUB_TOKEN` for private target checkouts if needed.
  Neither the service nor the repair agent needs Contents write.
- [ ] **M04 — Configure the agent account and budget.** Add `OPENAI_API_KEY` as a
  GitHub Actions secret. Set the dedicated project budget/limits and verify the
  15-minute attempt limit. Never place keys in notes, source code, or chat.
- [ ] **M05 — Configure review email.** Add the existing provider's
  `RESEND_API_KEY` as a GitHub secret. Set `MONITOR_EMAIL_TO` and a verified
  `MONITOR_EMAIL_FROM` as repository variables. Confirm delivery to the owner's
  inbox; do not use a newsletter group.
- [ ] **M06 — Connect CRE Radar's real outcomes.** Add a heartbeat call after its
  existing launchd pipeline. Report actual per-source completed/partial/failed
  outcomes, preserve the pipeline exit code, and log heartbeat transport errors.
  Keep CRE's single scheduler and SQLite writer; add no runtime model or AI key.
- [ ] **M07 — Prove the complete review loop.** Use a controlled incident to
  exercise dispatch, exact-SHA checkout, one isolated repair attempt, fresh-runner
  patch validation, artifact upload, and the review email. Verify diagnosis-only
  and failed attempts are clearly identified. No automatic commit or deployment.
- [ ] **M08 — Verify repeat protection and recovery.** Demonstrate the seven-day
  identical-incident cooldown, one dispatch per project per UTC day, rearming
  after recovery, and retry after a failed dispatch. Repeat after restoring state.
- [ ] **M09 — Enable monitoring of the monitor.** Set `MONITOR_HEALTH_URL` for the
  daily GitHub watchdog and enable its failure notifications. Simulate the service
  being unreachable and verify an alert. Its `/health` reports service health;
  `/status` reports application incidents.
- [ ] **M10 — Approve and activate.** After the acceptance checks, enable both
  `repair.enabled` in `projects.json` and repository variable
  `MONITOR_REPAIR_ENABLED=true`. Confirm one API/content and browser check per
  project per 24 hours. Do not imply that publishing source activates the service.

## Follow-up improvements

- [ ] **M11 — Improve incident evidence.** Attach bounded, sanitized per-source
  error summaries and failed run links, rather than relying only on job names.
  Keep upstream text as untrusted evidence and exclude credentials and SQL data.
- [ ] **M12 — Define ongoing operations.** Choose an owner, review response target,
  state backup/restore procedure, secret rotation procedure, and a monthly usage
  review. Patch artifacts currently expire after 14 days.

## Related application follow-ups

These are separate from activating the monitor:

- [ ] **SF Events canaries:** confirm Ticketmaster and Freight complete through
  the production GitHub runner after the fixes pushed in `440467a`.
- [ ] **Independent cleanup:** take a fresh recovery point, obtain explicit
  cleanup approval, and apply the reviewed nine-pair reconciliation. The SQL plan
  currently ends in `ROLLBACK`; nine duplicate event IDs would be retired.
- [ ] **Eventbrite / Spark Social:** resolve GitHub-runner HTTP 405 responses.
  Both adapters currently work locally; that does not verify Actions access.

Checkly is optional at this daily cadence; no subscription has been provisioned.
See [README.md](README.md) for setup, endpoints, permission boundaries and costs.
