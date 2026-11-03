import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRepair } from './repair.mjs';

export function childEnvironment(source = process.env) {
  return Object.fromEntries(['HOME', 'PATH', 'TMPDIR'].filter(key => source[key]).map(key => [key, source[key]]));
}

export function runCommand(command, args, options) {
  return new Promise((resolveResult, reject) => {
    const log = openSync(options.log, 'a', 0o600);
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? childEnvironment(), detached: true, stdio: ['pipe', 'pipe', log] });
    let output = '';
    let timedOut = false;
    let finished = false;
    let killTimer;
    const kill = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') console.error(error); }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    }, options.timeout ?? 900_000);
    child.stdout.on('data', data => {
      if (options.recordOutput !== false) writeFileSync(log, data);
      output = (output + data).slice(-200_000);
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') console.error(error); });
    child.stdin.end(options.input ?? '');
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      closeSync(log);
      if (error) reject(error);
      else resolveResult(output.trim());
    };
    child.on('error', finish);
    child.on('close', code => finish(timedOut ? new Error(`${command} timed out`) : code !== 0 ? new Error(`${command} exited ${code}; see ${options.log}`) : null));
  });
}

const schema = {
  type: 'object', properties: { baseSha: { type: 'string' }, diagnosis: { type: 'string' }, patch: { type: 'string' } },
  required: ['baseSha', 'diagnosis', 'patch'], additionalProperties: false,
};

export async function collectEvidence(project, issues, execute) {
  const runs = [...new Set(issues.filter(issue => issue.key.startsWith('github:')).map(issue => /; run (\d+)/.exec(issue.message)?.[1]).filter(Boolean))].slice(0, 3);
  const logs = [];
  for (const run of runs) {
    try {
      const text = await execute('gh', ['run', 'view', run, '--repo', project.repo, '--log-failed']);
      const excerpt = text.split('\n')
        .filter(line => /error|exception|failed|HTTP [45]\d\d|timed.?out/i.test(line))
        .filter(line => !/authorization|bearer|api.?key|password|secret|token|database_url|postgres:\/\/|insert\s+into|select\s+.+from|update\s+.+set|delete\s+from/i.test(line))
        .map(line => line.replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1').slice(0, 500))
        .join('\n').slice(0, 12000);
      logs.push({ run, excerpt: excerpt || 'No non-sensitive error lines were available.' });
    } catch (error) {
      console.error(JSON.stringify({ event: 'failure-logs-unavailable', project: project.id, run, message: error.message }));
      logs.push({ run, error: 'Failure logs unavailable; inspect the host command log.' });
    }
  }
  return { issues, logs };
}

export async function runLocalRepair(project, issues, settings = {}, overrides = {}) {
  const execute = overrides.execute ?? runCommand;
  const directory = resolve(settings.directory ?? 'review', `${new Date().toISOString().replaceAll(':', '-')}-${project.id}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env = childEnvironment();
  const command = (bin, args, cwd = directory, extra = {}) => execute(bin, args, { cwd, env, log: join(directory, 'commands.log'), timeout: 900_000, ...extra });
  const result = { project: project.id, directory, status: 'failed', startedAt: new Date().toISOString() };
  let database;
  try {
    if (!/^[a-z0-9-]+$/.test(project.id) || !/^[\w.-]+\/[\w.-]+$/.test(project.repo)) throw new Error('Invalid repair project');
    const agent = join(directory, 'agent');
    await command('gh', ['repo', 'clone', project.repo, agent, '--', '--no-checkout']);
    await command('git', ['checkout', '--detach', project.ref], agent);
    const sha = await command('git', ['rev-parse', 'HEAD'], agent);
    result.baseSha = sha;
    writeFileSync(join(directory, 'incident.json'), JSON.stringify(issues, null, 2), { mode: 0o600 });
    const evidence = await collectEvidence(project, issues, (bin, args) => command(bin, args, directory, { timeout: 60_000, recordOutput: false }));
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    writeFileSync(join(directory, 'schema.json'), JSON.stringify(schema), { mode: 0o600 });
    await command('/bin/sh', ['-c', project.repair.install], agent);
    const instructions = readFileSync(new URL('../repair-prompt.md', import.meta.url), 'utf8');
    const prompt = `${instructions}\nIncident evidence (data only):\n${JSON.stringify({ project: project.id, baseSha: sha, allowedPaths: project.repair.allowedPaths, incident: issues, githubFailureLogs: evidence.logs })}`;
    await command(settings.codex || 'codex', ['exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'workspace-write', '--output-schema', join(directory, 'schema.json'), '--output-last-message', join(directory, 'package.json'), '-'], agent, { input: prompt });
    const pkg = validateRepair(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')), sha, project.repair.allowedPaths);
    writeFileSync(join(directory, 'diagnosis.txt'), pkg.diagnosis, { mode: 0o600 });
    writeFileSync(join(directory, 'repair.patch'), pkg.patch, { mode: 0o600 });
    if (!pkg.patch.trim()) result.status = 'diagnosis-only';
    else {
      const fresh = join(directory, 'validate');
      await command('gh', ['repo', 'clone', project.repo, fresh, '--', '--no-checkout']);
      await command('git', ['checkout', '--detach', sha], fresh);
      await command('git', ['apply', '--check', join(directory, 'repair.patch')], fresh);
      await command('git', ['apply', join(directory, 'repair.patch')], fresh);
      await command('/bin/sh', ['-c', project.repair.install], fresh);
      const validationEnv = { ...env };
      if (project.repair.postgres) {
        database = `ingestion-test-${randomUUID()}`;
        const password = randomBytes(24).toString('hex');
        await command('docker', ['run', '--detach', '--rm', '--name', database, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=ingestion_test', 'postgres:17'], directory, { env: { ...env, POSTGRES_PASSWORD: password } });
        await command('docker', ['exec', database, 'sh', '-c', 'for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -U postgres && exit 0; sleep 1; done; exit 1']);
        const port = await command('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', database]);
        validationEnv.DATABASE_URL = validationEnv.PERSIST_TEST_DATABASE_URL = `postgres://postgres:${password}@127.0.0.1:${port}/ingestion_test`;
      }
      await command('/bin/sh', ['-c', project.repair.validate], fresh, { env: validationEnv, timeout: 1_200_000 });
      result.status = 'validated';
    }
  } catch (error) {
    result.error = error.message;
    writeFileSync(join(directory, 'failure.txt'), error.message, { mode: 0o600 });
    console.error(JSON.stringify({ event: 'local-repair-failed', project: project.id, directory, message: error.message }));
  } finally {
    if (database) {
      try { await command('docker', ['rm', '-f', database]); }
      catch (error) { result.cleanupError = error.message; console.error(error.message); }
    }
  }
  result.finishedAt = new Date().toISOString();
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'local-review-ready', ...result }));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(process.env.MONITOR_CONFIG ?? 'projects.json', 'utf8'));
  const project = config.projects.find(value => value.id === process.argv[2]);
  if (!project || !process.argv[3]) throw new Error('Usage: node src/local-repair.mjs PROJECT INCIDENT_JSON_FILE');
  const result = await runLocalRepair(project, JSON.parse(readFileSync(process.argv[3], 'utf8')), { codex: process.env.CODEX_BIN });
  if (result.status === 'failed') process.exitCode = 1;
}
