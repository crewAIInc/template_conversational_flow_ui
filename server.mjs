import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { attachWebSocketRelay } from './websocket-relay.mjs';

const root = dirname(fileURLToPath(import.meta.url));
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const production = process.argv.includes('--production');
const port = Number(process.env.PORT || 5173);
const token = process.env.CREWAI_BEARER_TOKEN;
let base;
try {
  base = new URL(process.env.CREWAI_AMP_URL);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) base = undefined;
} catch { /* A missing configuration is reported through /api/inspect. */ }
const configured = Boolean(base && token);
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const chatPath = new RegExp(`^/api/chat/(${uuid})/(history|message|stream/events)$`);
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const upstreamUrl = (path) => {
  const url = new URL(base);
  url.pathname = base.pathname.replace(/\/$/, '') + path;
  url.search = '';
  url.hash = '';
  return url;
};
const connectionError = (error) => error.cause?.code === 'ENOTFOUND'
  ? 'The deployment hostname could not be resolved. Check CREWAI_AMP_URL in .env.'
  : 'Could not reach the CrewAI deployment. Check the URL, token, and network connection.';
const sameOrigin = (req) => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
const allowedHost = req => [`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host);
const vite = production ? null : await (await import('vite')).createServer({
  root, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'spa',
});

const server = createServer(async (req, res) => {
  if (!allowedHost(req)) return json(res, 403, { error: 'Unknown host.' });
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
    if (!configured) return json(res, 503, { error: 'Set CREWAI_AMP_URL and CREWAI_BEARER_TOKEN in .env, then restart the server.' });
    const chat = url.pathname.match(chatPath);
    if (chat?.[2] === 'stream/events' && req.method === 'GET') {
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const timeout = setTimeout(() => controller.abort(), 120000);
      const target = upstreamUrl(`/chat/${chat[1]}/stream/events`);
      target.searchParams.set('events', '*');
      const lastId = url.searchParams.get('last_event_id') || '0-0';
      target.searchParams.set('last_event_id', /^\d+-\d+$/.test(lastId) ? lastId : '0-0');
      const started = Date.now();
      try {
        const response = await fetch(target, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal, redirect: 'error',
        });
        clearTimeout(timeout);
        if (!response.ok) {
          const body = await response.json().catch(() => ({ error: `CrewAI returned HTTP ${response.status}.` }));
          return json(res, response.status, body);
        }
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          await response.body?.cancel();
          return json(res, 502, { error: 'CrewAI did not return an SSE stream.' });
        }
        console.info(`CrewAI SSE connected (HTTP ${response.status}, headers after ${Date.now() - started}ms).`);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        for await (const chunk of response.body) {
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
        res.end();
      } catch (error) {
        if (!res.destroyed) {
          if (res.headersSent) res.destroy();
          else json(res, 502, { error: connectionError(error) });
        }
      } finally { clearTimeout(timeout); }
      return;
    }
    const path = url.pathname === '/api/inspect' && req.method === 'GET' ? '/inspect'
      : url.pathname === '/api/chat/start' && req.method === 'POST' ? '/chat/start'
      : chat?.[2] === 'history' && req.method === 'GET' ? `/chat/${chat[1]}/history`
      : chat?.[2] === 'message' && req.method === 'POST' ? `/chat/${chat[1]}/message` : null;
    if (!path) return json(res, 404, { error: 'Unknown API endpoint.' });
    try {
      let payload = {};
      if (chat?.[2] === 'message') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 128 * 1024) return json(res, 413, { error: 'Message is too large.' });
          chunks.push(chunk);
        }
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return json(res, 400, { error: 'Invalid JSON.' }); }
        if (typeof payload?.message !== 'string' || !payload.message.trim() || payload.message.length > 32000) {
          return json(res, 400, { error: 'A nonempty message of at most 32000 characters is required.' });
        }
        payload = { message: payload.message, stream: true };
      }
      const response = await fetch(upstreamUrl(path), {
        method: req.method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(req.method === 'POST' ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(20000), redirect: 'error',
      });
      const body = await response.json().catch(() => ({ error: `CrewAI returned HTTP ${response.status}.` }));
      // The browser only receives chat capability, never the full deployment configuration.
      if (path === '/inspect' && response.ok) return json(res, 200, { chat: body.flow?.chat ?? null });
      return json(res, response.status, body);
    } catch (error) { return json(res, 502, { error: connectionError(error) }); }
  }
  if (vite) return vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  const dist = resolve(root, 'dist');
  let path;
  try { path = resolve(dist, '.' + decodeURIComponent(url.pathname)); }
  catch { res.writeHead(400); return res.end('Invalid path.'); }
  if (!path.startsWith(dist + sep) && path !== dist) { res.writeHead(403); return res.end(); }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  try {
    let file = path;
    if (!extname(path)) file = resolve(dist, 'index.html');
    const contents = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : contents);
  } catch { res.writeHead(404); res.end('Not found. Run npm run build before npm start.'); }
});

attachWebSocketRelay(server, { port, base, token });

server.on('error', error => {
  console.error(`Could not start Flow Chat (${error.code}). Check that port ${port} is available and local listeners are permitted.`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`Flow Chat running at http://localhost:${port}`));
