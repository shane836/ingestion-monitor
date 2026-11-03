import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runLocalRepair, childEnvironment, runCommand } from '../src/local-repair.mjs';

const sha = 'a'.repeat(40);
const patch = 'diff --git a/lib/value.txt b/lib/value.txt\n--- a/lib/value.txt\n+++ b/lib/value.txt\n@@ -1 +1 @@\n-old\n+fixed\n';

test('repair children receive no monitor, email, or production credentials', () => {
  const env = childEnvironment({ HOME: '/home/example', PATH: '/bin', TMPDIR: '/tmp', MONITOR_API_TOKEN: 'private', RESEND_API_KEY: 'private', DATABASE_URL: 'production', GH_TOKEN: 'private', OPENAI_API_KEY: 'private' });
  assert.deepEqual(env, { HOME: '/home/example', PATH: '/bin', TMPDIR: '/tmp' });
});

test('validates a proposed patch in a fresh checkout, saves failures, and supports diagnosis only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-repair-test-'));
  const source = join(root, 'source');
  mkdirSync(join(source, 'lib'), { recursive: true });
  writeFileSync(join(source, 'lib/value.txt'), 'old\n');
  execFileSync('git', ['init', source]);
  const project = { id: 'sample', repo: 'owner/sample', ref: 'main', repair: { allowedPaths: ['lib/'], install: 'true', validate: 'true' } };
  let proposed = patch;
  let rejectValidation = false;
  let workspaces = [];
  const execute = async (command, args, options) => {
    if (command === 'gh') {
      const destination = args[3];
      mkdirSync(join(destination, 'lib'), { recursive: true });
      writeFileSync(join(destination, 'lib/value.txt'), 'old\n');
      execFileSync('git', ['init', destination]);
      workspaces.push(destination);
    } else if (command === 'git' && args[0] === 'rev-parse') return sha;
    else if (command === 'git' && args[0] === 'checkout') return '';
    else if (command === 'codex-test') {
      const output = args[args.indexOf('--output-last-message') + 1];
      writeFileSync(output, JSON.stringify({ baseSha: sha, diagnosis: 'Controlled fixture', patch: proposed }));
      // Agent changes must not cross into the validator checkout.
      writeFileSync(join(options.cwd, 'lib/value.txt'), 'agent-only\n');
    } else if (command === '/bin/sh' && args[1] === 'true') {
      if (rejectValidation && options.cwd.endsWith('validate')) throw new Error('validation failed');
    } else return execFileSync(command, args, { cwd: options.cwd, encoding: 'utf8' });
    return '';
  };
  try {
    const settings = { directory: join(root, 'reviews'), codex: 'codex-test' };
    const first = await runLocalRepair(project, [{ key: 'fixture', message: 'controlled' }], settings, { execute });
    assert.equal(first.status, 'validated');
    assert.equal(workspaces.length, 2);
    assert.equal(readFileSync(join(first.directory, 'repair.patch'), 'utf8'), patch);
    assert.equal(readFileSync(join(first.directory, 'validate/lib/value.txt'), 'utf8'), 'fixed\n');
    assert.equal(readFileSync(join(source, 'lib/value.txt'), 'utf8'), 'old\n');
    rejectValidation = true;
    const failed = await runLocalRepair(project, [], settings, { execute });
    assert.equal(failed.status, 'failed');
    assert.match(readFileSync(join(failed.directory, 'result.json'), 'utf8'), /validation failed/);
    proposed = '';
    const diagnosis = await runLocalRepair(project, [], settings, { execute });
    assert.equal(diagnosis.status, 'diagnosis-only');
    proposed = patch.replaceAll('lib/value.txt', '.env');
    const protectedPatch = await runLocalRepair(project, [], settings, { execute });
    assert.equal(protectedPatch.status, 'failed');
    assert.match(protectedPatch.error, /protected/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a timed-out repair command stops and records failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-timeout-'));
  try {
    await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, log: join(root, 'log'), timeout: 50 }), /timed out/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
