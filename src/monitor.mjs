import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalRepair } from './local-repair.mjs';

const field = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const ageHours = (date, now) => (now - new Date(date)) / 3_600_000;
const issue = (key, message) => ({ key, message: String(message).slice(0, 500) });

export function validateConfig(config) {
  if (!Array.isArray(config?.projects) || !config.projects.length) throw new Error('Configure at least one project');
  const ids = new Set();
  for (const project of config.projects) {
    if (!/^[a-z0-9-]+$/.test(project.id) || ids.has(project.id)) throw new Error('Project IDs must be unique lowercase slugs');
    ids.add(project.id);
    if (!/^[\w.-]+\/[\w.-]+$/.test(project.repo) || !project.ref) throw new Error(`Invalid repository for ${project.id}`);
    for (const check of [...(project.http ?? []), ...(project.browser ? [project.browser] : [])]) {
      if (!['http:', 'https:'].includes(new URL(check.url).protocol)) throw new Error('Check URLs must use HTTP(S)');
    }
    for (const settings of [project.heartbeat, project.github]) {
      if (settings && (!Number.isFinite(settings.maxAgeHours) || settings.maxAgeHours <= 0)) throw new Error('Freshness must be a positive number of hours');
    }
  }
  return config;
}

async function browserCheck(check) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(check.url, { timeout: 45_000, waitUntil: 'domcontentloaded' });
    if (!response?.ok()) throw new Error(`Homepage HTTP ${response?.status()}`);
    for (const selector of check.selectors ?? []) await page.locator(selector).first().waitFor({ state: 'visible', timeout: 15_000 });
    if (errors.length) throw new Error(`Browser JavaScript errors: ${errors.join('; ')}`);
  } finally { await browser.close(); }
}

async function githubJson(path, deps) {
  const response = await deps.fetch(`https://api.github.com/${path}`, {
    headers: { Accept: 'application/vnd.github+json', ...(deps.githubToken ? { Authorization: `Bearer ${deps.githubToken}` } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}

export async function checkProject(project, state = {}, overrides = {}) {
  const deps = { fetch: globalThis.fetch, now: () => new Date(), browserCheck, ...overrides };
  const now = deps.now();
  const issues = [];
  for (const check of project.http ?? []) {
    try {
      const response = await deps.fetch(check.url, { signal: AbortSignal.timeout(30_000) });
      if (response.status !== (check.status ?? 200)) throw new Error(`HTTP ${response.status}`);
      if (check.includesText && !(await response.text()).includes(check.includesText)) throw new Error('Expected page content is missing');
      if (check.jsonArrayPath) {
        const rows = field(await response.json(), check.jsonArrayPath);
        if (!Array.isArray(rows) || rows.length < (check.minimumItems ?? 0)) throw new Error('Expected records are missing');
        for (const row of rows) {
          if ((check.requiredFields ?? []).some(path => !field(row, path))) throw new Error('Required record fields are missing');
          if (check.futureField) {
            const time = Date.parse(field(row, check.futureField));
            if (!Number.isFinite(time) || time < now.getTime()) throw new Error('Invalid or past event date');
          }
        }
      }
    } catch (error) { issues.push(issue(`http:${check.id}`, error.message)); }
  }
  if (project.browser) {
    try { await deps.browserCheck(project.browser); }
    catch (error) { issues.push(issue('browser', error.message)); }
  }
  if (project.heartbeat) {
    const heartbeat = state.heartbeat;
    const age = ageHours(heartbeat?.receivedAt, now);
    if (!heartbeat || !Number.isFinite(age) || age > project.heartbeat.maxAgeHours) issues.push(issue('heartbeat:stale', 'Ingestion heartbeat is missing or stale'));
    else if (heartbeat.status !== 'completed') issues.push(issue('heartbeat:failed', `Ingestion ${heartbeat.status}: ${(heartbeat.sources ?? []).filter(source => source.status !== 'completed').map(source => source.source).join(', ')}`));
  }
  if (project.github) {
    try {
      const workflow = encodeURIComponent(project.github.workflow);
      const data = await githubJson(`repos/${project.repo}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(project.ref)}&per_page=1`, deps);
      const run = data.workflow_runs?.[0];
      const age = ageHours(run?.created_at, now);
      if (!run || !Number.isFinite(age) || age > project.github.maxAgeHours) issues.push(issue('github:stale', 'Scheduled ingestion workflow is missing or stale'));
      else if (run.status !== 'completed' && age > (project.github.maxRunHours ?? 1)) issues.push(issue('github:hung', 'Ingestion workflow exceeded its expected duration'));
      else if (run.status === 'completed' && run.conclusion !== 'success') {
        let page = 1;
        const failed = [];
        while (true) {
          const jobs = await githubJson(`repos/${project.repo}/actions/runs/${run.id}/jobs?per_page=100&page=${page++}`, deps);
          for (const job of jobs.jobs ?? []) {
            if (['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(job.conclusion)) failed.push(`${job.name}: ${job.conclusion}`);
          }
          if ((jobs.jobs?.length ?? 0) < 100) break;
        }
        for (const name of failed.sort()) issues.push(issue(`github:${name}`, `Failed ingestion job ${name}; run ${run.id}`));
        if (!failed.length) issues.push(issue('github:failed', `Ingestion workflow ${run.conclusion}; run ${run.id}`));
      }
    } catch (error) { issues.push(issue('github:unavailable', error.message)); }
  }
  return issues;
}

export async function runCycle(config, state, overrides = {}) {
  const deps = { fetch: globalThis.fetch, now: () => new Date(), ...overrides };
  const results = [];
  for (const project of config.projects) {
    const previous = state[project.id] ?? {};
    const issues = await checkProject(project, previous, deps);
    const fingerprint = createHash('sha256').update(JSON.stringify(issues.map(value => value.key).sort())).digest('hex');
    const current = { ...previous, checkedAt: deps.now().toISOString(), issues, fingerprint: issues.length ? fingerprint : null };
    // Changed incidents and recovered incidents rearm; unchanged failures wait
    // seven days by default. A failed dispatch is never marked delivered.
    const due = issues.length && (previous.dispatchedFingerprint !== fingerprint || ageHours(previous.dispatchedAt, deps.now()) >= (config.cooldownHours ?? 168));
    if (!issues.length) current.dispatchedFingerprint = null;
    if (due && config.repair?.enabled !== false) {
      const day = deps.now().toISOString().slice(0, 10);
      const count = previous.dispatchDay === day ? previous.dispatchCount ?? 0 : 0;
      if (count < (config.maxRepairsPerDay ?? 3)) {
        try {
          if (deps.dispatch) await deps.dispatch(project, issues);
          else {
            // Persist the attempt before starting a long-running local process.
            // A restart must not spend another attempt on the same incident.
            Object.assign(current, { dispatchedFingerprint: fingerprint, dispatchedAt: deps.now().toISOString(), dispatchDay: day, dispatchCount: count + 1 });
            state[project.id] = current;
            await deps.persist?.();
            current.review = await runLocalRepair(project, issues, { codex: deps.codex });
          }
          Object.assign(current, { dispatchedFingerprint: fingerprint, dispatchedAt: deps.now().toISOString(), dispatchDay: day, dispatchCount: count + 1, dispatchError: null });
        } catch (error) { current.dispatchError = error.message; }
      } else current.dispatchError = 'Daily repair limit reached';
    }
    // A heartbeat may arrive while an HTTP/browser check is awaiting I/O.
    if (state[project.id]?.heartbeat) current.heartbeat = state[project.id].heartbeat;
    state[project.id] = current;
    results.push({ project: project.id, ...current });
  }
  return results;
}

export function loadState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

async function main() {
  const config = validateConfig(JSON.parse(readFileSync(process.env.MONITOR_CONFIG ?? 'projects.json', 'utf8')));
  const path = process.env.MONITOR_STATE ?? 'state/incidents.json';
  const state = loadState(path);
  const results = await runCycle(config, state, { githubToken: process.env.GITHUB_TOKEN, codex: process.env.CODEX_BIN, persist: () => saveState(path, state) });
  saveState(path, state);
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => result.issues.length || result.dispatchError)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
