import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProject, runCycle, validateConfig } from '../src/monitor.mjs';
import { validateRepair } from '../src/repair.mjs';

const project = { id: 'events', repo: 'owner/events', ref: 'main', http: [{ id: 'api', url: 'https://example.com/api', jsonArrayPath: 'events', minimumItems: 1, requiredFields: ['id', 'venue.name'], futureField: 'startsAt' }] };
const now = new Date('2026-10-24T12:00:00Z');
const response = () => new Response(JSON.stringify({ events: [{ id: '1', venue: { name: 'Hall' }, startsAt: '2026-10-25T00:00:00Z' }] }));
const deps = { now: () => now, fetch: async () => response() };

test('validates independent project configurations and rejects duplicates', () => {
  assert.equal(validateConfig({ projects: [project] }).projects.length, 1);
  assert.throws(() => validateConfig({ projects: [project, project] }));
  assert.throws(() => validateConfig({ projects: [{ ...project, http: [{ url: 'file:///etc/passwd' }] }] }));
});
test('checks nested event fields and future dates without an app dependency', async () => {
  assert.deepEqual(await checkProject(project, {}, deps), []);
  for (const body of [{}, { events: [] }, { events: [{ id: '1' }] }, { events: [{ id: '1', venue: { name: 'Hall' }, startsAt: '2020-01-01' }] }]) {
    assert.equal((await checkProject(project, {}, { ...deps, fetch: async () => new Response(JSON.stringify(body)) })).length, 1);
  }
});
test('surfaces browser and transport failures', async () => {
  const p = { ...project, browser: { url: 'https://example.com', selectors: ['h1'] } };
  const issues = await checkProject(p, {}, { ...deps, fetch: async () => { throw new Error('network down'); }, browserCheck: async () => { throw new Error('missing h1'); } });
  assert.equal(issues.length, 2);
});
test('detects stale and failed heartbeats and healthy empty source runs', async () => {
  const p = { ...project, heartbeat: { maxAgeHours: 36 } };
  assert.equal((await checkProject(p, {}, deps)).length, 1);
  assert.deepEqual(await checkProject(p, { heartbeat: { receivedAt: now.toISOString(), status: 'completed' } }, deps), []);
  assert.equal((await checkProject(p, { heartbeat: { receivedAt: '2026-10-01T00:00:00Z', status: 'completed' } }, deps)).length, 1);
  assert.equal((await checkProject(p, { heartbeat: { receivedAt: now.toISOString(), status: 'partial', sources: [{ source: 'a', status: 'failed' }] } }, deps)).length, 1);
});
test('detects failed GitHub sources and missing scheduled runs', async () => {
  const p = { ...project, http: [], github: { workflow: 'ingest.yml', maxAgeHours: 36 } };
  const fetch = async url => new Response(JSON.stringify(String(url).includes('/jobs') ? { jobs: [{ name: 'ingest (bad)', conclusion: 'failure' }] } : { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'failure', created_at: now.toISOString() }] }));
  assert.equal((await checkProject(p, {}, { ...deps, fetch })).length, 1);
  assert.equal((await checkProject(p, {}, { ...deps, fetch: async () => new Response('{"workflow_runs":[]}') })).length, 1);
});
test('deduplicates incidents, rearms after recovery, and retries unsuccessful dispatches', async () => {
  const config = { projects: [project], cooldownHours: 168 };
  const state = {};
  let dispatches = 0;
  const failing = { ...deps, fetch: async () => new Response('{}'), dispatch: async () => { dispatches++; } };
  await runCycle(config, state, failing);
  await runCycle(config, state, failing);
  assert.equal(dispatches, 1);
  await runCycle(config, state, deps);
  await runCycle(config, state, failing);
  assert.equal(dispatches, 2);
  const retryState = {};
  await runCycle(config, retryState, { ...failing, dispatch: async () => { throw new Error('dispatch unavailable'); } });
  await runCycle(config, retryState, failing);
  assert.equal(dispatches, 3);
});
test('patch boundary rejects protected files, stale commits and symlinks', () => {
  const sha = 'a'.repeat(40);
  const patch = 'diff --git a/lib/example.ts b/lib/example.ts\n--- a/lib/example.ts\n+++ b/lib/example.ts\n@@ -1 +1 @@\n-old\n+fixed\n';
  const pkg = { baseSha: sha, diagnosis: 'Evidence and cause', patch };
  assert.equal(validateRepair(pkg, sha, ['lib/', 'tests/']).patch, patch);
  assert.throws(() => validateRepair(pkg, 'b'.repeat(40), ['lib/']));
  for (const path of ['.github/workflows/ingest.yml', '.env', 'db/schema.ts', 'lib/../../secret']) {
    assert.throws(() => validateRepair({ ...pkg, patch: patch.replaceAll('lib/example.ts', path) }, sha, ['lib/']));
  }
  assert.throws(() => validateRepair({ ...pkg, patch: patch.replace('--- a/', 'new file mode 120000\n--- a/') }, sha, ['lib/']));
  assert.equal(validateRepair({ ...pkg, patch: '' }, sha, ['lib/']).patch, '');
});
