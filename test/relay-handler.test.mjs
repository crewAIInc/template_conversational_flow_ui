import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';

// Exercise the actual HTTP handler without opening TCP ports in restricted sessions.
test('SSE HTTP handler flushes frames before upstream EOF and validates message/auth boundaries', async t => {
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
    if (String(url).includes('/stream/events')) {
      return new Response(new ReadableStream({ start(controller) { streamController = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
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
  const res = request(`/api/chat/${id}/stream/events?events=token&last_event_id=123-4`);
  await once(res, 'headers');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  const frame = 'data: {"id":"123-5","type":"token","data":{"content":"hello ✓"}}\n\n';
  const chunk = once(res, 'chunk');
  streamController.enqueue(new TextEncoder().encode(frame));
  await chunk;
  assert.equal(Buffer.concat(res.parts).toString(), frame);
  assert.equal(res.writableFinished, false); // The first token arrived while upstream remained open.
  const finished = once(res, 'finish');
  streamController.close(); await finished;
  assert.match(calls[0].url, /events=\*&last_event_id=123-4$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-only-secret');
  const posted = request(`/api/chat/${id}/message`, 'POST', JSON.stringify({ message: 'hi ✓', stream: false, ignored: true }));
  await once(posted, 'finish');
  assert.deepEqual(JSON.parse(calls[1].options.body), { message: 'hi ✓', stream: true });
  const invalid = request(`/api/chat/${id}/message`, 'POST', '{'); await once(invalid, 'finish');
  assert.equal(invalid.statusCode, 400);
  const denied = request('/api/inspect', 'GET', '', { origin: 'https://untrusted.example' });
  if (!denied.writableFinished) await once(denied, 'finish');
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 2);
});
