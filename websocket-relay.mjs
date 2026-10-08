import WebSocket, { WebSocketServer } from 'ws';

const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const pathPattern = new RegExp(`^/api/chat/(${uuid})/stream$`);

export function attachWebSocketRelay(server, { port, base, token }) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const reject = (status, reason) => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(pathPattern);
    if (!match) return reject(404, 'Not Found');
    if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host)
      || req.headers.origin !== `http://${req.headers.host}`) return reject(403, 'Forbidden');
    if (!base || !token) return reject(503, 'Service Unavailable');
    const target = new URL(base);
    target.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    target.pathname = base.pathname.replace(/\/$/, '') + `/chat/${match[1]}/stream`;
    target.search = ''; target.hash = '';
    target.searchParams.set('events', '*');
    const lastId = url.searchParams.get('last_event_id') || '0-0';
    target.searchParams.set('last_event_id', /^\d+-\d+$/.test(lastId) ? lastId : '0-0');
    // Create a fresh handshake. Never forward browser handshake headers or put the token in a URL.
    const upstream = new WebSocket(target, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 20000, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false,
    });
    let client;
    const stopUpstream = () => { if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate(); };
    socket.on('close', stopUpstream);
    upstream.on('unexpected-response', (request, response) => {
      console.error(`CrewAI WebSocket handshake failed: HTTP ${response.statusCode}.`);
      reject(502, 'Bad Gateway'); response.resume(); request.destroy(); stopUpstream();
    });
    upstream.on('error', error => {
      // Log only a code; third-party error text can include authentication details.
      console.error(`CrewAI WebSocket connection failed (${error.code || 'handshake or transport error'}).`);
      if (client?.readyState === WebSocket.OPEN) client.close(1011, 'Deployment WebSocket connection failed.');
      else reject(502, 'Bad Gateway');
    });
    upstream.on('open', () => {
      if (socket.destroyed) return stopUpstream();
      // The browser's open event proves the deployment accepted its WebSocket handshake too.
      sockets.handleUpgrade(req, socket, head, connected => {
        client = connected;
        console.info(`CrewAI WebSocket connected (HTTP 101, session ${match[1]}).`);
        client.on('error', stopUpstream);
        client.on('close', stopUpstream);
        client.on('message', (data, binary) => {
          let payload;
          try { if (binary) throw new Error(); payload = JSON.parse(data.toString()); }
          catch { return client.close(1008, 'A JSON text message is required.'); }
          if (typeof payload?.message !== 'string' || !payload.message.trim() || payload.message.length > 32000) {
            return client.close(1008, 'A nonempty message of at most 32000 characters is required.');
          }
          if (upstream.readyState !== WebSocket.OPEN) return client.close(1011, 'Deployment WebSocket is closed.');
          upstream.send(JSON.stringify({ message: payload.message, events: '*', lastEventId: /^\d+-\d+$/.test(payload.lastEventId || '') ? payload.lastEventId : lastId }));
        });
      });
    });
    upstream.on('message', (data, binary) => {
      if (client?.readyState === WebSocket.OPEN) {
        // Bound memory if a browser stops consuming events.
        if (client.bufferedAmount > 4 * 1024 * 1024) return client.close(1013, 'Client is receiving events too slowly.');
        client.send(data, { binary });
      }
    });
    upstream.on('close', code => {
      console.info(`CrewAI WebSocket closed (code ${code}, session ${match[1]}).`);
      if (client?.readyState === WebSocket.OPEN) client.close(code === 1006 || code === 1005 ? 1011 : code, code === 1000 ? '' : 'Deployment WebSocket closed.');
      else if (!client) reject(502, 'Bad Gateway');
    });
  });
  return sockets;
}
