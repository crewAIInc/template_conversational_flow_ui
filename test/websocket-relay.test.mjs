import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter, once } from 'node:events';
import { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { attachWebSocketRelay } from '../websocket-relay.mjs';

// Real WebSocket handshakes/frames over paired streams, without TCP listeners.
test('WebSocket relay sends messages, streams all frames, protects auth, and rejects bad handshakes', { timeout: 5000 }, async t => {
  const originals = { http: http.request, https: https.request };
  const proxy = http.createServer();
  const remote = new WebSocketServer({ noServer: true });
  const local = attachWebSocketRelay(proxy, { port: 5199, base: new URL('https://test.example'), token: 'server-only-secret' });
  const connections = [], streams = [], requests = [];
  let acceptUpstream;
  let failHandshake = false;
  function pair() {
    let a, b;
    a = new Duplex({ read() {}, write(chunk, encoding, done) { b.push(Buffer.from(chunk)); done(); }, final(done) { b.push(null); done(); } });
    b = new Duplex({ read() {}, write(chunk, encoding, done) { a.push(Buffer.from(chunk)); done(); }, final(done) { a.push(null); done(); } });
    streams.push(a, b);
    return [a, b];
  }
  function request(options) {
    requests.push(options);
    const pending = new EventEmitter();
    pending.setHeader = () => {};
    pending.abort = pending.destroy = () => {};
    pending.end = () => queueMicrotask(() => {
      const [clientSocket, serverSocket] = pair();
      const headers = Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value]));
      headers.host = options.host === 'test.example' ? 'test.example' : 'localhost:5199';
      const req = { method: 'GET', url: options.path, headers };
      function onData(chunk) {
        const text = chunk.toString();
        clientSocket.removeListener('data', onData);
        const statusCode = Number(text.split(' ')[1]);
        const responseHeaders = Object.fromEntries(text.split('\r\n').slice(1).filter(line => line.includes(':')).map(line => {
          const at = line.indexOf(':'); return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
        }));
        if (statusCode === 101) pending.emit('upgrade', { statusCode, headers: responseHeaders }, clientSocket, Buffer.alloc(0));
        else pending.emit('response', { statusCode, headers: responseHeaders, resume() {} });
      }
      clientSocket.on('data', onData);
      if (options.host === 'test.example') {
        acceptUpstream = () => {
          if (failHandshake) return serverSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
          remote.handleUpgrade(req, serverSocket, Buffer.alloc(0), socket => { connections.push(socket); remote.emit('connection', socket, req); });
        };
      } else proxy.emit('upgrade', req, serverSocket, Buffer.alloc(0));
    });
    return pending;
  }
  http.request = https.request = request;
  t.after(() => {
    http.request = originals.http; https.request = originals.https;
    connections.forEach(socket => socket.terminate());
    streams.forEach(stream => stream.destroy()); local.close(); remote.close(); proxy.close();
  });
  const id = '11111111-2222-3333-4444-555555555555';
  const client = new WebSocket(`ws://localhost:5199/api/chat/${id}/stream?events=token&last_event_id=123-0`, { origin: 'http://localhost:5199', perMessageDeflate: false });
  connections.push(client);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.readyState, WebSocket.CONNECTING, 'Browser must wait for deployment acceptance');
  const connected = once(client, 'open');
  acceptUpstream(); await connected;
  assert.equal(requests[1].path, `/chat/${id}/stream?events=*&last_event_id=123-0`);
  assert.equal(requests[1].headers.Authorization, 'Bearer server-only-secret');
  assert.ok(requests.every(options => !options.path.includes('server-only-secret')));
  assert.ok(!requests[0].headers.Authorization);
  assert.notEqual(requests[0].headers['Sec-WebSocket-Key'], requests[1].headers['Sec-WebSocket-Key']);
  const upstream = connections.find(socket => socket !== client);
  const message = once(upstream, 'message');
  client.send(JSON.stringify({ message: 'Hello ✓', events: 'token', lastEventId: '123-0', token: 'untrusted' }));
  assert.deepEqual(JSON.parse((await message)[0]), { message: 'Hello ✓', events: '*', lastEventId: '123-0' });
  for (const frame of [
    { id: '123-1', type: 'llm_stream_chunk', data: { chunk: 'Hello ✓' } },
    { id: '123-2', type: 'tool_usage_finished', data: { nested: { value: true } } },
    { id: '123-3', type: 'turn_completed', data: {} },
  ]) {
    const received = once(client, 'message'); upstream.send(JSON.stringify(frame));
    assert.deepEqual(JSON.parse((await received)[0]), frame);
    assert.equal(client.readyState, WebSocket.OPEN);
  }
  const closed = once(client, 'close'); client.send('{');
  assert.equal((await closed)[0], 1008);
  const count = requests.length;
  const denied = new WebSocket(`ws://localhost:5199/api/chat/${id}/stream`, { origin: 'https://untrusted.example', perMessageDeflate: false });
  connections.push(denied);
  const rejection = once(denied, 'unexpected-response');
  const [, deniedResponse] = await rejection;
  assert.equal(deniedResponse.statusCode, 403);
  denied.terminate(); denied.on('error', () => {});
  assert.equal(requests.length, count + 1, 'Rejected origin must not reach deployment');
  failHandshake = true;
  const failed = new WebSocket(`ws://localhost:5199/api/chat/${id}/stream`, { origin: 'http://localhost:5199', perMessageDeflate: false });
  connections.push(failed);
  const failedResponse = once(failed, 'unexpected-response');
  await new Promise(resolve => setImmediate(resolve)); acceptUpstream();
  assert.equal((await failedResponse)[1].statusCode, 502);
  assert.equal(failed.readyState, WebSocket.CONNECTING);
  failed.on('error', () => {}); failed.terminate();
});
