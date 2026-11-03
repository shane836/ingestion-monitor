import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function emailSettings(source = process.env) {
  if (source.MONITOR_EMAIL_ENABLED !== 'true') return { enabled: false };
  const settings = { enabled: true, key: source.RESEND_API_KEY, from: source.MONITOR_EMAIL_FROM, to: source.MONITOR_EMAIL_TO };
  if (!settings.key || !settings.from || !settings.to) throw new Error('RESEND_API_KEY, MONITOR_EMAIL_FROM and MONITOR_EMAIL_TO are required for email');
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(settings.to)) throw new Error('Configure exactly one recipient for private monitor notifications');
  return settings;
}

export async function notifyCycle(results, state, settings = { enabled: false }, overrides = {}) {
  if (!settings.enabled) return null;
  const key = createHash('sha256').update(JSON.stringify(results.map(result => [result.project, result.fingerprint, result.review?.directory, result.review?.status]))).digest('hex');
  const previous = state._notification ?? {};
  if (previous.key === key) return previous;
  const failing = results.filter(result => result.issues?.length);
  const text = results.map(result => {
    const lines = [`${result.project}: ${result.issues?.length ? 'ISSUES DETECTED' : 'HEALTHY'}`];
    for (const issue of result.issues ?? []) lines.push(`- ${issue.message}`);
    if (result.review) {
      lines.push(`Latest review: ${result.review.status}`, `Local files: ${result.review.directory}`);
      const diagnosis = join(result.review.directory, 'diagnosis.txt');
      if (existsSync(diagnosis)) lines.push(readFileSync(diagnosis, 'utf8').slice(0, 6000));
      if (result.review.error) lines.push(`Repair error: ${result.review.error}`);
    }
    if (result.dispatchError) lines.push(`Dispatch: ${result.dispatchError}`);
    return lines.join('\n');
  }).join('\n\n');
  try {
    const response = await (overrides.fetch ?? globalThis.fetch)('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(30_000), redirect: 'error',
      headers: { Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `monitor-${key}-${previous.id ?? 'initial'}` },
      body: JSON.stringify({ from: settings.from, to: [settings.to], subject: `[Ingestion Monitor] ${failing.length ? `${failing.length} project(s) need review` : 'Recovery: projects healthy'}`, text: `${text}\n\nReview files are on your Mac. Nothing was automatically committed or deployed.\nRun npm run status in ingestion-monitor for current state.` }),
    });
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
    const body = await response.json();
    if (typeof body.id !== 'string' || !body.id) throw new Error('Resend response has no message ID');
    state._notification = { key, id: body.id, sentAt: new Date().toISOString(), error: null };
  } catch (error) {
    state._notification = { ...previous, attemptedAt: new Date().toISOString(), error: error.message };
    console.error(JSON.stringify({ event: 'email-failed', message: error.message }));
  }
  return state._notification;
}
