import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectChatStream, isCurrentTurnFrame } from '../src/chat-stream.mjs';

function setup(t, history = { messages: [], active_kickoff_id: null }) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = { WebSocket: globalThis.WebSocket, EventSource: globalThis.EventSource, window: globalThis.window };
  const sockets = [], streams = [], posts = [], events = [], frames = [], failures = [], statuses = [];
  let finished = 0, valid = true;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = new URL(url); this.sent = []; this.readyState = 0; sockets.push(this); }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.onclose?.({ code: 1006, reason: '' }); }
  }
  class Events {
    constructor(url) { this.url = new URL(url); streams.push(this); }
    close() { this.closed = true; }
  }
  globalThis.WebSocket = Socket; globalThis.EventSource = Events;
  globalThis.window = { location: { href: 'http://localhost:5173/', protocol: 'http:' } };
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const turn = { id: '11111111-2222-3333-4444-555555555555', message: 'Hello', previousUsers: 0, retries: 0, sent: false, lastId: '0-0', terminal: false };
  const callbacks = {
    connection: {},
    api: async (path, method, payload) => { if (method === 'POST') { posts.push({ path, payload }); return { status: 'queued' }; } return history; },
    isCurrent: () => valid,
    status: value => statuses.push(value), log: (type, detail) => events.push({ type, detail }),
    onMessage: event => frames.push(JSON.parse(event.data)),
    finish: () => { finished++; turn.terminal = true; if (turn.transport !== 'WebSocket') turn.source?.close(); },
    fail: value => failures.push(value),
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function disconnect(activeTurn = turn) {
    const wait = 500 * (activeTurn.retries + 1);
    activeTurn.source.close(); t.mock.timers.tick(wait); await flush();
  }
  return { turn, callbacks, sockets, streams, posts, events, frames, failures, statuses, disconnect, flush, finished: () => finished, cancel: () => { valid = false; } };
}

test('initial WebSocket attempt plus three retries then SSE queues once, forwards events, and stops stale callbacks', async t => {
  const h = setup(t); connectChatStream(h.turn, h.callbacks);
  for (let retry = 0; retry < 3; retry++) {
    await h.disconnect();
    assert.equal(h.sockets.length, retry + 2);
    assert.equal(h.streams.length, 0);
    assert.equal(h.posts.length, 0);
  }
  await h.disconnect();
  assert.equal(h.sockets.length, 4);
  assert.equal(h.streams.length, 1);
  assert.deepEqual(h.events.filter(e => e.type === 'transport_retry').map(e => e.detail.retry), [1, 2, 3]);
  assert.equal(h.events.filter(e => e.type === 'sse_fallback').length, 1);
  assert.deepEqual(h.posts, [{ path: `/chat/${h.turn.id}/message`, payload: { message: 'Hello', stream: true } }]);
  const source = h.streams[0]; source.onopen();
  assert.equal(h.statuses.at(-1), 'Connected · SSE');
  const frame = { type: 'llm_stream_chunk', stream_id: '123-1', data: { chunk: 'Hello' } };
  source.onmessage({ data: JSON.stringify(frame) });
  assert.deepEqual(h.frames, [frame]);
  h.cancel(); source.onmessage({ data: JSON.stringify(frame) }); source.onerror();
  t.mock.timers.tick(10000); await h.flush();
  assert.equal(h.frames.length, 1);
  assert.equal(h.streams.length, 1);
});

test('a delivered WebSocket message falls back to SSE attach at the same cursor without another send', async t => {
  const h = setup(t, { active_kickoff_id: 'running', messages: [] });
  connectChatStream(h.turn, h.callbacks); h.sockets[0].open();
  assert.equal(h.sockets[0].sent.length, 1);
  h.turn.lastId = '123-4';
  for (let attempt = 0; attempt < 4; attempt++) await h.disconnect();
  assert.equal(h.streams.length, 1);
  assert.equal(h.streams[0].url.searchParams.get('last_event_id'), '123-4');
  assert.equal(h.streams[0].url.searchParams.get('events'), '*');
  assert.equal(h.posts.length, 0);
  assert.equal(h.sockets.reduce((count, socket) => count + socket.sent.length, 0), 1);
  h.streams[0].onerror(); t.mock.timers.tick(500); await h.flush();
  assert.equal(h.streams.length, 2);
  assert.equal(h.posts.length, 0);
  for (const wait of [1000, 1500, 2000]) {
    h.streams.at(-1).onerror(); t.mock.timers.tick(wait); await h.flush();
  }
  assert.equal(h.streams.length, 4);
  assert.match(h.failures[0], /SSE stream disconnected repeatedly/);
  assert.equal(h.posts.length, 0);
});

test('history completion ends recovery before retries or fallback', async t => {
  const h = setup(t, { active_kickoff_id: null, messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }] });
  connectChatStream(h.turn, h.callbacks); h.sockets[0].open(); await h.disconnect();
  assert.equal(h.finished(), 1);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.streams.length, 0);
  assert.equal(h.posts.length, 0);
});

test('uncertain WebSocket delivery is never resubmitted through SSE', async t => {
  const h = setup(t); connectChatStream(h.turn, h.callbacks); h.sockets[0].open();
  await h.disconnect();
  assert.match(h.failures[0], /delivery could not be confirmed/);
  assert.equal(h.turn.terminal, true);
  assert.equal(h.posts.length, 0);
  assert.equal(h.streams.length, 0);
});

test('an uncertain HTTP send is reconciled and SSE attaches without sending again', async t => {
  const history = { active_kickoff_id: null, messages: [] };
  const h = setup(t, history);
  h.callbacks.api = async (path, method, payload) => {
    if (method === 'POST') { h.posts.push({ path, payload }); history.active_kickoff_id = 'running'; throw new Error('Request timed out'); }
    return history;
  };
  connectChatStream(h.turn, h.callbacks);
  for (let attempt = 0; attempt < 4; attempt++) await h.disconnect();
  assert.equal(h.posts.length, 1);
  t.mock.timers.tick(500); await h.flush();
  assert.equal(h.streams.length, 1);
  assert.equal(h.posts.length, 1);
  assert.equal(h.failures.length, 0);
});

for (const terminal of ['turn_completed', 'turn_failed']) {
  test(`one session reuses its open socket after ${terminal}, resetting the turn cursor`, t => {
    const h = setup(t);
    h.callbacks.onMessage = event => { h.frames.push(JSON.parse(event.data)); h.callbacks.finish(); };
    connectChatStream(h.turn, h.callbacks); h.sockets[0].open();
    h.turn.lastId = '123-9';
    h.sockets[0].onmessage({ data: JSON.stringify({ type: terminal, kickoff_id: 'first' }) });
    assert.equal(h.turn.terminal, true);
    assert.equal(h.sockets[0].readyState, WebSocket.OPEN);
    assert.ok(!h.sockets[0].closed);
    const next = { ...h.turn, message: 'Next', terminal: false, sent: false, retries: 0, lastId: '0-0', previousUsers: 1 };
    const nextFrames = [];
    connectChatStream(next, { ...h.callbacks, onMessage: event => nextFrames.push(JSON.parse(event.data)) });
    assert.equal(h.sockets.length, 1);
    assert.equal(next.source, h.turn.source);
    assert.deepEqual(h.sockets[0].sent.map(message => [message.message, message.lastEventId]), [['Hello', '0-0'], ['Next', '0-0']]);
    assert.equal(h.events.filter(e => e.type === 'websocket_connected').length, 1);
    assert.equal(h.events.filter(e => e.type === 'websocket_reused').length, 1);
    h.sockets[0].onmessage({ data: JSON.stringify({ type: 'token', kickoff_id: 'second', data: { content: 'new reply' } }) });
    assert.equal(nextFrames.length, 1);
    assert.equal(h.frames.length, 1, 'Previous turn callback must not receive the new turn');
  });
}

test('idle server closure clears the cached socket without retries; next turn opens a fresh socket', async t => {
  const h = setup(t); connectChatStream(h.turn, h.callbacks); h.sockets[0].open(); h.callbacks.finish();
  h.sockets[0].close(); t.mock.timers.tick(10000); await h.flush();
  assert.equal(h.callbacks.connection.source, null);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.events.filter(e => e.type === 'websocket_idle_closed').length, 1);
  assert.equal(h.events.filter(e => e.type === 'transport_retry').length, 0);
  assert.equal(h.failures.length, 0);
  const next = { ...h.turn, message: 'Next', terminal: false, sent: false, retries: 0, lastId: '0-0' };
  connectChatStream(next, h.callbacks); h.sockets[1].open();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].sent[0].message, 'Next');
  assert.equal(h.streams.length, 0);
});

test('a reused socket that disconnects still retries three times and falls back without resending', async t => {
  const h = setup(t, { active_kickoff_id: 'running', messages: [] });
  connectChatStream(h.turn, h.callbacks); h.sockets[0].open(); h.callbacks.finish();
  const next = { ...h.turn, message: 'Next', terminal: false, sent: false, retries: 0, lastId: '0-0' };
  connectChatStream(next, h.callbacks);
  next.lastId = '456-7';
  for (let attempt = 0; attempt < 4; attempt++) await h.disconnect(next);
  assert.equal(h.sockets.length, 4); // First socket was reused, followed by three new attempts.
  assert.equal(h.streams.length, 1);
  assert.equal(h.streams[0].url.searchParams.get('last_event_id'), '456-7');
  assert.equal(h.posts.length, 0);
  assert.equal(h.sockets.reduce((count, socket) => count + socket.sent.filter(message => message.message === 'Next').length, 0), 1);
});

test('replayed events and completion from older turns cannot affect a new or resumed turn', () => {
  const turn = {};
  assert.equal(isCurrentTurnFrame({ type: 'mcp_tool_execution_started', kickoff_id: 'old' }, turn), false);
  assert.equal(isCurrentTurnFrame({ type: 'turn_completed', kickoff_id: 'old' }, turn), false);
  assert.equal(isCurrentTurnFrame({ type: 'turn_started', kickoff_id: 'new', data: { status: 'queued' } }, turn), true);
  assert.equal(turn.kickoffId, 'new');
  assert.equal(isCurrentTurnFrame({ type: 'mcp_tool_execution_started', kickoff_id: 'new' }, turn), true);
  assert.equal(isCurrentTurnFrame({ type: 'turn_completed', kickoff_id: 'old' }, turn), false);
  assert.equal(isCurrentTurnFrame({ type: 'mcp_tool_execution_started', kickoff_id: 'new' }, { kickoffId: 'new' }), true);
  assert.equal(isCurrentTurnFrame({ type: 'error', data: { message: 'Request rejected' } }, turn), true);
});
