import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';

test('authenticates triggers and project heartbeats; persists failures and rejects overlaps', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const config = { projects: [{ id: 'cre', repo: 'owner/cre', ref: 'main', http: [], heartbeat: { maxAgeHours: 36, tokenEnv: 'CRE_TOKEN' } }], repair: { enabled: false } };
  const service = createService(config, { statePath: join(directory, 'state.json'), apiToken: 'admin-test', tokens: { CRE_TOKEN: 'cre-test' }, dispatch: async () => {} });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const running = service.run();
    await assert.rejects(service.run(), /in progress/);
    await running;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/heartbeats/cre`, { method: 'POST', headers: { Authorization: 'Bearer admin-test' }, body: '{"status":"completed"}' })).status, 401);
    const heartbeat = await fetch(`${base}/heartbeats/cre`, { method: 'POST', headers: { Authorization: 'Bearer cre-test' }, body: '{"status":"completed","sources":[{"source":"na","status":"failed"}]}' });
    assert.equal(heartbeat.status, 400);
    assert.equal((await fetch(`${base}/heartbeats/cre`, { method: 'POST', headers: { Authorization: 'Bearer cre-test' }, body: '{"status":"partial","sources":[{"source":"na","status":"failed"}]}' })).status, 204);
    const response = await fetch(`${base}/run`, { method: 'POST', headers: { Authorization: 'Bearer admin-test' } });
    assert.equal(response.status, 200);
    const status = await (await fetch(`${base}/status`, { headers: { Authorization: 'Bearer admin-test' } })).json();
    assert.equal(status.cre.issues[0].key, 'heartbeat:failed');
    const restored = createService(config, { statePath: join(directory, 'state.json'), apiToken: 'admin-test', tokens: {} });
    assert.equal(restored.state.cre.heartbeat.status, 'partial');
    assert.equal((await fetch(`${base}/heartbeats/cre`, { method: 'POST', headers: { Authorization: 'Bearer cre-test' }, body: 'x'.repeat(70_000) })).status, 413);
  } finally {
    await new Promise(resolve => service.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
