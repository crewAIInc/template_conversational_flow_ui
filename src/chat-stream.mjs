const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// One initial WebSocket attempt plus three retries, then HTTP send + SSE attach.
export function connectChatStream(turn, { api, isCurrent, status, log, onMessage, finish, fail }) {
  turn.transport = 'WebSocket';
  const current = () => !turn.terminal && isCurrent();
  function stop(error) {
    if (!current()) return;
    turn.terminal = true; turn.source?.close(); fail(error.message);
  }
  async function connect() {
    if (!current()) return;
    try {
      if (turn.transport === 'SSE' && turn.message && !turn.sent && !turn.attachOnly) {
        status('Queuing turn');
        // Never retry a send whose delivery is uncertain, even when changing transports.
        turn.sent = true;
        const queued = await api(`/chat/${turn.id}/message`, 'POST', { message: turn.message, stream: true });
        if (!current()) return;
        log('turn_queued', queued);
      }
      status(turn.retries ? `Reconnecting ${turn.transport}` : `Connecting ${turn.transport}`);
      const target = new URL(`/api/chat/${turn.id}/stream${turn.transport === 'SSE' ? '/events' : ''}`, window.location.href);
      target.searchParams.set('events', '*'); target.searchParams.set('last_event_id', turn.lastId);
      if (turn.transport === 'WebSocket') target.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const source = turn.transport === 'SSE' ? new EventSource(target) : new WebSocket(target);
      turn.source = source;
      const active = () => current() && turn.source === source;
      source.onopen = () => {
        if (!active()) { source.close(); return; }
        status(`Connected · ${turn.transport}`);
        log(turn.transport === 'SSE' ? 'sse_connected' : 'websocket_connected', { last_event_id: turn.lastId });
        if (turn.transport === 'WebSocket' && turn.message && !turn.sent && !turn.attachOnly) {
          turn.sent = true;
          try {
            source.send(JSON.stringify({ message: turn.message, events: '*', lastEventId: turn.lastId }));
            log('message_sent', 'Sent over WebSocket; waiting for turn_started.');
          } catch (error) { recover(error.message); }
        }
      };
      source.onmessage = event => { if (active()) onMessage(event); };
      source.onerror = () => {
        if (!active()) return;
        if (turn.transport === 'SSE') recover('SSE stream disconnected.');
        else log('websocket_error', 'WebSocket transport failed. Check server logs for the deployment handshake status.');
      };
      if (turn.transport === 'WebSocket') source.onclose = event => {
        if (active()) recover(`WebSocket closed (code ${event.code})${event.reason ? ': ' + event.reason : '.'}`);
      };
    } catch (error) { recover(error.message); }
  }
  async function recover(failure) {
    if (!current() || turn.recovering) return;
    turn.recovering = true;
    turn.source?.close();
    log(turn.transport === 'SSE' ? 'sse_disconnected' : 'websocket_disconnected', failure);
    status('Checking turn');
    try {
      await delay(500 * (turn.retries + 1));
      if (!current()) return;
      const history = await api(`/chat/${turn.id}/history`);
      if (!current()) return;
      turn.attachOnly = Boolean(history.active_kickoff_id);
      if (!turn.attachOnly) {
        const users = (history.messages || []).filter(m => m.role === 'user');
        if (!turn.message || (users.length > turn.previousUsers && users.at(-1)?.content === turn.message)) {
          log('history_synced', 'The turn finished. Final history is authoritative.');
          return finish();
        }
        if (turn.sent) throw new Error('Message delivery could not be confirmed. Your message is restored; it will not be sent again automatically.');
      }
      if (turn.retries < 3) {
        turn.retries++;
        log('transport_retry', { transport: turn.transport, retry: turn.retries, max_retries: 3 });
      } else if (turn.transport === 'WebSocket') {
        turn.transport = 'SSE'; turn.retries = 0;
        log('sse_fallback', { reason: failure, websocket_retries: 3, last_event_id: turn.lastId });
      } else throw new Error('The SSE stream disconnected repeatedly. Reconnect to attach to the active turn.');
      turn.recovering = false;
      connect();
    } catch (error) { stop(error); }
    finally { turn.recovering = false; }
  }
  connect();
}
