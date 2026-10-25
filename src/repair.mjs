import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export function validateRepair(pkg, expectedSha, allowedPaths) {
  if (!pkg || pkg.baseSha !== expectedSha || !/^[a-f0-9]{40}$/.test(pkg.baseSha)) throw new Error('Repair base SHA mismatch');
  if (typeof pkg.diagnosis !== 'string' || !pkg.diagnosis.trim() || pkg.diagnosis.length > 20_000) throw new Error('Invalid diagnosis');
  if (typeof pkg.patch !== 'string' || Buffer.byteLength(pkg.patch) > 150_000) throw new Error('Invalid or oversized patch');
  if (!pkg.patch.trim()) return pkg;
  if (/^(?:new file mode|new mode) 120000|^rename from |^copy from |^GIT binary patch/m.test(pkg.patch)) throw new Error('Unsupported patch type');
  const stats = execFileSync('git', ['apply', '--numstat', '-z', '-'], { cwd: tmpdir(), input: pkg.patch, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const files = stats.split('\0').filter(Boolean).map(line => line.split('\t').slice(2).join('\t'));
  if (!files.length || files.length > 10 || files.some(path =>
    !/^[a-zA-Z0-9_./()[\]-]+$/.test(path) || path.split('/').includes('..') ||
    !allowedPaths.some(prefix => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix) ||
    /(^|\/)\.env|(^|\/)\.github\//.test(path)
  )) throw new Error('Patch touches protected or unsupported paths');
  return pkg;
}

function main() {
  const config = JSON.parse(readFileSync(process.env.MONITOR_CONFIG ?? 'projects.json', 'utf8'));
  const project = config.projects.find(value => value.id === process.env.REPAIR_PROJECT);
  if (!project) throw new Error('Unknown repair project');
  const pkg = validateRepair(JSON.parse(readFileSync('review/package.json', 'utf8')), process.env.REPAIR_BASE_SHA, project.repair.allowedPaths);
  writeFileSync('review/diagnosis.txt', pkg.diagnosis);
  writeFileSync('review/repair.patch', pkg.patch);
  if (!pkg.patch.trim()) return console.log('Diagnosis only: no patch to validate');
  execFileSync('git', ['apply', '--check', resolve('review/repair.patch')], { cwd: 'target', stdio: 'inherit' });
  execFileSync('git', ['apply', resolve('review/repair.patch')], { cwd: 'target', stdio: 'inherit' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
