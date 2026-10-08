import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';

// Exercise the actual HTTP handler without opening TCP ports in restricted sessions.
test('HTTP handler validates message/auth boundaries and keeps deployment configuration server-side', async t => {
  const originalFetch = globalThis.fetch;
  const originalListen = Server.prototype.listen;
  const originalArgv = process.argv;
  const originalEnv = { PORT: process.env.PORT, CREWAI_AMP_URL: process.env.CREWAI_AMP_URL, CREWAI_BEARER_TOKEN: process.env.CREWAI_BEARER_TOKEN };
  let server, streamController;
  const calls = [];
  process.argv = [...process.argv, '--production'];
  Object.assign(process.env, { PORT: '5199', CREWAI_AMP_URL: 'https://test.example', CREWAI_BEARER_TOKEN: 'test-only-secret' });
  Server.prototype.listen = function () { server = this; return this; };
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/stream/events')) return new Response(new ReadableStream({ start(controller) { streamController = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (String(url).endsWith('/inspect')) return Response.json({ flow: { chat: { conversational: true, handle_turn: true } }, secret: 'test-only-secret' });
    return Response.json({ status: 'queued' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch; Server.prototype.listen = originalListen; process.argv = originalArgv;
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  await import('../server.mjs');
  function request(path, method = 'GET', body = '', headers = {}) {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { url: path, method, headers: { host: 'localhost:5199', ...headers } });
    const res = new Writable({ write(chunk, encoding, callback) { res.parts.push(Buffer.from(chunk)); res.emit('chunk'); callback(); } });
    res.parts = []; res.headersSent = false;
    res.writeHead = (status, values) => { res.statusCode = status; res.headers = values; res.headersSent = true; return res; };
    res.flushHeaders = () => res.emit('headers');
    server.emit('request', req, res);
    return res;
  }
  const id = '11111111-2222-3333-4444-555555555555';
  const posted = request(`/api/chat/${id}/message`, 'POST', JSON.stringify({ message: 'hi ✓', stream: false, ignored: true }));
  await once(posted, 'finish');
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: 'hi ✓', stream: true });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-only-secret');
  const invalid = request(`/api/chat/${id}/message`, 'POST', '{'); await once(invalid, 'finish');
  assert.equal(invalid.statusCode, 400);
  const denied = request('/api/inspect', 'GET', '', { origin: 'https://untrusted.example' });
  if (!denied.writableFinished) await once(denied, 'finish');
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 1);
  const inspected = request('/api/inspect'); await once(inspected, 'finish');
  assert.deepEqual(JSON.parse(Buffer.concat(inspected.parts).toString()), { chat: { conversational: true, handle_turn: true } });
  const streamed = request(`/api/chat/${id}/stream/events?events=token&last_event_id=123-4`);
  await once(streamed, 'headers');
  assert.equal(streamed.headers['Content-Type'], 'text/event-stream');
  assert.equal(streamed.headers['X-Accel-Buffering'], 'no');
  const frame = 'data: {"stream_id":"123-5","type":"token","data":{"content":"hello ✓"}}\n\n';
  const received = once(streamed, 'chunk');
  streamController.enqueue(new TextEncoder().encode(frame)); await received;
  assert.equal(Buffer.concat(streamed.parts).toString(), frame);
  assert.equal(streamed.writableFinished, false);
  assert.match(calls.at(-1).url, /events=\*&last_event_id=123-4$/);
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer test-only-secret');
  const completed = once(streamed, 'finish'); streamController.close(); await completed;
});
