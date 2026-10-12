import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';

test('TCP WebSocket relay streams two turns on one connection with server-only auth', { timeout: 15000 }, async t => {
  const id = '11111111-2222-3333-4444-555555555555';
  const token = 'test-secret-kept-on-server';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const upstream = createServer((req, res) => res.end('{}'));
  const remote = new WebSocketServer({ server: upstream });
  const clients = [];
  let connections = 0, turns = 0;
  remote.on('connection', (socket, req) => {
    connections++;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.url, `/chat/${id}/stream?events=*&last_event_id=123-0`);
    socket.on('message', async raw => {
      turns++;
      assert.deepEqual(JSON.parse(raw), { message: turns === 1 ? 'Hello flow' : 'Hello again', events: '*', lastEventId: turns === 1 ? '123-0' : '0-0' });
      socket.send(JSON.stringify({ id: '123-1', type: 'token', data: { content: 'Hello ' } }));
      await gate;
      socket.send(JSON.stringify({ id: '123-2', type: 'turn_completed', data: {} }));
    });
  });
  const reservation = createServer();
  t.after(() => {
    release(); clients.forEach(client => client.terminate());
    remote.clients.forEach(client => client.terminate()); remote.close(); upstream.close(); reservation.close();
  });
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
  const client = new WebSocket(`ws://127.0.0.1:${port}/api/chat/${id}/stream?events=token&last_event_id=123-0`, { origin: `http://127.0.0.1:${port}` });
  clients.push(client);
  await once(client, 'open');
  const text = once(client, 'message');
  client.send(JSON.stringify({ message: 'Hello flow', events: 'token', lastEventId: '123-0', token: 'ignored' }));
  assert.equal(JSON.parse((await text)[0]).data.content, 'Hello ');
  const completed = once(client, 'message');
  release();
  assert.equal(JSON.parse((await completed)[0]).type, 'turn_completed');
  assert.equal(client.readyState, WebSocket.OPEN);
  const nextText = once(client, 'message');
  const nextCompleted = new Promise(resolve => client.on('message', raw => {
    const frame = JSON.parse(raw); if (frame.type === 'turn_completed') resolve(frame);
  }));
  client.send(JSON.stringify({ message: 'Hello again', events: '*', lastEventId: '0-0' }));
  assert.equal(JSON.parse((await nextText)[0]).data.content, 'Hello ');
  assert.equal((await nextCompleted).type, 'turn_completed');
  assert.equal(connections, 1);
  assert.equal(turns, 2);
  assert.equal(client.readyState, WebSocket.OPEN);
});
