// Node loads the ignored .env before this script; credentials never enter argv.
const action = process.argv[2];
if (!['status', 'run', 'notify'].includes(action)) throw new Error('Use npm run status, npm run run:now or npm run email:test');
if (!process.env.MONITOR_API_TOKEN) throw new Error('MONITOR_API_TOKEN is required in .env');
const response = await fetch(`http://127.0.0.1:${Number(process.env.PORT ?? 8080)}/${action}`, {
  method: action === 'status' ? 'GET' : 'POST',
  headers: { Authorization: `Bearer ${process.env.MONITOR_API_TOKEN}` },
  signal: AbortSignal.timeout(2_400_000),
});
const body = await response.json();
console.log(JSON.stringify(body, null, 2));
if (!response.ok) process.exitCode = 1;
