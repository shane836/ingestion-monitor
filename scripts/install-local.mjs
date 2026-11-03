import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workingDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const label = 'com.masonequity.ingestion-monitor';
const agents = join(homedir(), 'Library/LaunchAgents');
const file = join(agents, `${label}.plist`);
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
if (!existsSync(join(workingDirectory, '.env'))) throw new Error('Create the ignored .env before installing');
if (existsSync(file)) {
  // Read before replacing an existing installation.
  const previous = readFileSync(file, 'utf8');
  if (!previous.includes(xml(join(workingDirectory, 'src/service.mjs')))) throw new Error(`Refusing to replace a different installation: ${file}`);
  throw new Error(`Already installed: ${file}. Use launchctl kickstart -k gui/${process.getuid()}/${label} to restart.`);
}
mkdirSync(agents, { recursive: true });
mkdirSync(join(workingDirectory, 'state'), { recursive: true, mode: 0o700 });
const args = [process.execPath, '--env-file=.env', join(workingDirectory, 'src/service.mjs')];
writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${join(homedir(), '.local/bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(workingDirectory, 'state/service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(workingDirectory, 'state/service-error.log'))}</string>
</dict></plist>`, { mode: 0o600 });
execFileSync('plutil', ['-lint', file], { stdio: 'inherit' });
execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, file], { stdio: 'inherit' });
console.log(`Installed ${label}. Local checks resume at login and while the Mac is awake.`);
