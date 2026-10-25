import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, loadState, saveState, runCycle } from './monitor.mjs';

function authorized(request, token) {
  if (!token) return false;
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(request.headers.authorization ?? ''), hash(`Bearer ${token}`));
}
async function jsonBody(request) {
  if (Number(request.headers['content-length']) > 65_536) {
    request.resume();
    throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 65_536) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  try { return JSON.parse(body); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export function createService(config, options) {
  validateConfig(config);
  if (!options.apiToken) throw new Error('MONITOR_API_TOKEN is required');
  const state = loadState(options.statePath);
  let running = false;
  let serviceError = null;
  const persist = () => saveState(options.statePath, state);
  async function run() {
    if (running) throw Object.assign(new Error('A check is already in progress'), { status: 409 });
    running = true;
    try {
      const results = await runCycle(config, state, options);
      state._meta = { checkedAt: new Date().toISOString() };
      persist();
      serviceError = null;
      console.log(JSON.stringify({ event: 'monitor-cycle', results }));
      return results;
    } catch (error) { serviceError = error.message; throw error; }
    finally { running = false; }
  }
  const server = createServer(async (request, response) => {
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(data == null ? '' : JSON.stringify(data)); };
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/health') return send(serviceError ? 503 : 200, { ok: !serviceError });
      const match = /^\/heartbeats\/([a-z0-9-]+)$/.exec(path);
      if (request.method === 'POST' && match) {
        const project = config.projects.find(project => project.id === match[1]);
        if (!project?.heartbeat) return send(404, { error: 'Heartbeat is not configured' });
        if (!authorized(request, options.tokens?.[project.heartbeat.tokenEnv])) return send(401, { error: 'Unauthorized' });
        const body = await jsonBody(request);
        if (!['completed', 'partial', 'failed'].includes(body?.status) ||
            (body.sources != null && (!Array.isArray(body.sources) || body.sources.length > 200 || body.sources.some(source => !source || typeof source.source !== 'string' || source.source.length > 200 || !['completed', 'partial', 'failed'].includes(source.status)))) ||
            (body.status === 'completed' && body.sources?.some(source => source.status !== 'completed'))) return send(400, { error: 'Invalid heartbeat outcome' });
        state[project.id] ??= {};
        state[project.id].heartbeat = { receivedAt: new Date().toISOString(), status: body.status, sources: body.sources ?? [] };
        persist();
        return send(204);
      }
      if (!authorized(request, options.apiToken)) return send(401, { error: 'Unauthorized' });
      if (request.method === 'GET' && path === '/status') return send(200, state);
      if (request.method === 'POST' && path === '/run') return send(200, await run());
      return send(404, { error: 'Not found' });
    } catch (error) {
      console.error(JSON.stringify({ event: 'request-error', message: error.message }));
      return send(error.status ?? 500, { error: error.status ? error.message : 'Monitor request failed; check service logs' });
    }
  });
  server.requestTimeout = 30_000;
  return { server, state, run };
}

function main() {
  const config = JSON.parse(readFileSync(process.env.MONITOR_CONFIG ?? 'projects.json', 'utf8'));
  const service = createService(config, { statePath: process.env.MONITOR_STATE ?? 'state/incidents.json', apiToken: process.env.MONITOR_API_TOKEN, tokens: process.env, githubToken: process.env.GITHUB_TOKEN });
  const checkDue = () => {
    const previous = Date.parse(service.state._meta?.checkedAt ?? '');
    if (!Number.isFinite(previous) || Date.now() - previous >= 24 * 3_600_000) service.run().catch(error => console.error(JSON.stringify({ event: 'cycle-error', message: error.message })));
  };
  const timer = setInterval(checkDue, 60_000);
  service.server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => { console.log('Ingestion monitor listening'); checkDue(); });
  const stop = () => { clearInterval(timer); service.server.close(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
