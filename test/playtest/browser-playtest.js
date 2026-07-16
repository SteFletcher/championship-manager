import { spawn } from 'node:child_process';

const baseUrl = 'http://127.0.0.1:8123/';
let server = null;

async function isServing() {
  try {
    const response = await fetch(baseUrl);
    return response.ok;
  } catch {
    return false;
  }
}

if (!await isServing()) {
  server = spawn('python3', ['-m', 'http.server', '8123', '--bind', '127.0.0.1'], {
    cwd: new URL('../..', import.meta.url),
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 30 && !await isServing(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!await isServing()) {
    server.kill();
    throw new Error('could not start the browser playtest server on port 8123');
  }
}

process.env.CHAMPMAN_TEST_URL = `${baseUrl}?seed=1592594996`;
try {
  await import('../browser-smoke.js');
} finally {
  server?.kill();
}
