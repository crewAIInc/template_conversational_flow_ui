import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

test('SSE relay flushes before completion, forwards all frames and cursors, and keeps auth server-side', { timeout: 15000 }, async t => {
  const id = '11111111-2222-3333-4444-555555555555';
  const token = 'test-secret-kept-on-server';
  const requests = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const frames = [
    { id: '123-1', type: 'turn_started', data: { status: 'running' } },
    { id: '123-2', type: 'token', data: { content: 'Hello ' } },
    { id: '123-3', type: 'event', data: { event_type: 'tool_usage_finished', arbitrary: { result: '✓' } } },
    { id: '123-4', type: 'token', data: { content: 'back!' } },
    { id: '123-5', type: 'turn_completed', data: {} },
  ];
  const upstream = createServer(async (req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url.startsWith(`/chat/${id}/stream/events`)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n' + frames.slice(0, 2).map(f => `data: ${JSON.stringify(f)}\n\n`).join(''));
      await gate;
      res.end(frames.slice(2).map(f => `data: ${JSON.stringify(f)}\n\n`).join(''));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/inspect') res.end(JSON.stringify({ flow: { chat: { conversational: true, handle_turn: true } }, secrets: token }));
    else if (req.url === '/chat/start') res.end(JSON.stringify({ session_id: id }));
    else if (req.url === `/chat/${id}/message`) {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { message: 'Hello flow', stream: true });
      res.end(JSON.stringify({ session_id: id, kickoff_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'queued' }));
    } else if (req.url.endsWith('/stream/events?events=*&last_event_id=0-0')) {
      res.writeHead(409); res.end(JSON.stringify({ detail: 'No active chat turn' }));
    } else res.end(JSON.stringify({ session_id: id, messages: [{ role: 'assistant', content: 'Hello back!' }], active_kickoff_id: null }));
  });
  const reservation = createServer();
  t.after(() => { release(); upstream.closeAllConnections(); upstream.close(); reservation.close(); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.mjs', '--production'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), CREWAI_AMP_URL: `http://127.0.0.1:${upstream.address().port}`, CREWAI_BEARER_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let output = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('Flow Chat running')) resolve(); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', code => reject(new Error(`Relay exited ${code}: ${output}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(await (await fetch(base + '/api/inspect')).json(), { chat: { conversational: true, handle_turn: true } });
  assert.equal((await fetch(base + '/api/inspect', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/inspect', { headers: { Host: 'untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/chat/invalid/history')).status, 404);
  assert.equal((await fetch(base + '/api/kickoff', { method: 'POST' })).status, 404);
  assert.equal((await fetch(base + '/api/chat/start', { method: 'POST' })).status, 200);
  const messageUrl = base + `/api/chat/${id}/message`;
  assert.equal((await fetch(messageUrl, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(messageUrl, { method: 'POST', body: JSON.stringify({ message: '' }) })).status, 400);
  assert.equal((await fetch(messageUrl, { method: 'POST', body: JSON.stringify({ message: 'Hello flow', stream: false, token: 'ignored' }) })).status, 200);
  const response = await fetch(base + `/api/chat/${id}/stream/events?events=token&last_event_id=123-0`);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  const first = await reader.read(); // Must arrive while the upstream response is still open.
  let raw = new TextDecoder().decode(first.value);
  assert.match(raw, /Hello /);
  assert.ok(!raw.includes('turn_completed'));
  release();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; raw += new TextDecoder().decode(chunk.value); }
  assert.deepEqual(raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))), frames);
  assert.ok(requests.every(req => req.authorization === `Bearer ${token}`));
  assert.ok(requests.every(req => !req.url.includes(token)));
  assert.ok(requests.some(req => req.url === `/chat/${id}/stream/events?events=*&last_event_id=123-0`));
  const inactiveId = '99999999-2222-3333-4444-555555555555';
  assert.equal((await fetch(base + `/api/chat/${inactiveId}/stream/events`)).status, 409);
  assert.equal((await fetch(base + '/%ZZ')).status, 400);
});
