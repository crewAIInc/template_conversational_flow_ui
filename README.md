# CrewAI Conversational Flow UI Template

A reusable React + [assistant-ui](https://www.assistant-ui.com/docs) chat interface for a deployed CrewAI conversational Flow. Configure your deployment URL and bearer token in `.env`, then run the UI. The template includes conversation history, Markdown responses, incremental text rendering, reconnect handling, and an Events panel with every received frame.

Messages, response chunks, and runtime events use CrewAI's [WebSocket API](https://docs-platform.crewai.com/platform/en/guides/conversational-flow-chat#option-b-websocket-attach-or-send). After three WebSocket retries, the UI falls back to [HTTP message + SSE](https://docs-platform.crewai.com/platform/en/guides/conversational-flow-chat#option-a-http-message-sse-attach). HTTP also creates sessions and loads history.

## Connect your deployed Flow

You need Node.js **22.12 or newer** and a conversational Flow already deployed on CrewAI AMP.

1. Open your automation in CrewAI AMP and find its **Status** tab.
2. Copy the automation's **deployment URL** and **bearer token**. Use the same token you would use to call `/kickoff`.
3. Create `.env` from the example in a fresh copy of this template:

   ```sh
   cp -n .env.example .env
   ```

   If `.env` already exists, edit that file instead.

4. Set both values in `.env`:

   ```dotenv
   CREWAI_AMP_URL=https://your-flow-url.crewai.com
   CREWAI_BEARER_TOKEN="replace-with-your-deployment-bearer-token"
   # PORT=5173
   ```

   `CREWAI_AMP_URL` is the automation's base URL, not the AMP dashboard URL. Do not append `/chat`, `/kickoff`, or a session ID. Supply the token value without a `Bearer ` prefix; the Node server adds that prefix to the Authorization header.

5. Install and start:

   ```sh
   npm ci
   npm run dev
   ```

Open **http://localhost:5173**, send a message, and open **Events** to inspect the response chunks and runtime activity. The UI checks `/inspect` before enabling messages. The deployment must report both `flow.chat.conversational: true` and `flow.chat.handle_turn: true`.

The Node server reads `.env` at startup. After changing credentials or server code, stop the running process with **Ctrl+C**, rerun `npm run dev`, and refresh the browser. Frontend hot reload is disabled, so refresh after UI changes too.

The token stays on the Node server. `.env` is ignored by Git; `.env.example` contains placeholders. Keep these variables server-side, without a `VITE_` prefix. Template copies and shared archives should include `.env.example` only.

## How the UI connects

```text
React / assistant-ui → local Node relay → deployed CrewAI Flow
                      bearer auth       WebSocket send + stream
```

| Deployment endpoint | Purpose |
| --- | --- |
| `GET /inspect` | Check conversational chat capability |
| `POST /chat/start` | Create a session |
| `WS /chat/{session_id}/stream?events=*&last_event_id=0-0` | Send a message or attach to an active turn; receive all runtime and text frames |
| `POST /chat/{session_id}/message` | Queue an unsent message with `stream: true` during SSE fallback |
| `GET /chat/{session_id}/stream/events?events=*&last_event_id=0-0` | Attach to the turn over SSE after WebSocket retries are exhausted |
| `GET /chat/{session_id}/history` | Load the authoritative transcript and active turn ID |

The browser calls matching `/api/...` routes on the local server. Native `WebSocket` connects to `/api/chat/{session_id}/stream`. The relay opens a separate authenticated WebSocket to CrewAI, then completes the browser handshake only after CrewAI accepts its connection. The token stays in the server-side Authorization header, never in a browser URL.

On connection, the UI sends `{ "message": "...", "events": "*", "lastEventId": "0-0" }` if it has a new message. Otherwise, it attaches to the active turn. The UI makes one initial WebSocket attempt and up to **three retries**, then switches to native `EventSource` for SSE. Events shows `transport_retry`, `sse_fallback`, and `sse_connected` so the switch is visible.

Before retrying or switching transports, the UI checks authoritative history. If no message was sent, SSE fallback queues it once over HTTP. If the turn is active, SSE attaches without resending, preserving the event cursor and already displayed text. If the turn has completed, the UI loads history. If delivery is uncertain and history cannot confirm acceptance, the UI restores the draft instead of sending it again automatically.

The UI supports both text formats:

```json
{ "type": "token", "data": { "content": "Hello " } }
{ "type": "llm_stream_chunk", "data": { "chunk": "world" } }
```

Each chunk updates the assistant message as received. If both formats arrive in a turn, normalized `token` frames take precedence to prevent duplicate text. Terminal frames refresh history, so completed replies also appear when the Flow emits no text chunks.

The **Events** panel retains every received JSON frame, including text chunks, with the full payload and millisecond receipt time. WebSocket ping/pong control frames are transport messages and do not appear as JSON events. Event logs are held in memory for the current conversation; the sidebar persists only session IDs and titles in this browser. Transcripts stay on CrewAI.

Only one turn runs per session. After a disconnect, the UI checks history and reattaches using the last Redis stream cursor. It never automatically resends a user message. SSE gets up to three recovery attempts; if those fail, use **Reconnect**. Each new turn starts with WebSocket again.

## Reuse and customize

Copy the template source into your own project, install dependencies, and configure its `.env`. Each copy can connect to a different conversational Flow through the two environment variables above.

| File | Customize |
| --- | --- |
| `src/App.jsx` | Chat layout, branding, suggestions, assistant-ui runtime, and event display |
| `src/styles.css` | Colors, spacing, and responsive layout |
| `src/assets/crewai-logo.png` | Top-left CrewAI logo |
| `src/stream-text.mjs` | Text-frame handling |
| `src/chat-stream.mjs` | WebSocket retries, SSE fallback, and delivery recovery |
| `server.mjs` | HTTP session/history routes, SSE relay, and server configuration |
| `websocket-relay.mjs` | Authenticated WebSocket handshake, message validation, and frame forwarding |
| `index.html` | Page title and favicon |

When switching deployments in the same browser, start a **New thread**. Existing sidebar sessions belong to their original deployment; use a separate browser profile or clear this site's storage if you want a clean conversation list.

## Build and verify

```sh
npm run build
npm start
```

`npm start` serves the built frontend and the Node relay on localhost, using the same environment variables. Public or multi-user hosting requires application authentication, per-user session authorization, and appropriate host/origin configuration. HITL feedback submission uses CrewAI's review workflow and is outside this template.

```sh
npm test
```

Tests use mock deployment data, not your real token or automation. They cover text chunks, safe React rendering, server-only auth, message validation, event/cursor forwarding, and forwarding text before the upstream turn completes. The TCP relay test needs local listeners. In restricted environments, run:

```sh
node --test test/chat-stream.test.mjs test/stream-text.test.mjs test/relay-handler.test.mjs test/websocket-relay.test.mjs test/render.test.mjs
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing configuration or unavailable deployment | Set both `.env` values and restart the Node server. |
| Conversational chat unavailable | Verify the deployed Flow exposes `conversational: true` and `handle_turn: true` in `/inspect`. |
| Authentication failure | Use this automation's bearer token, without a `Bearer ` prefix in `.env`. |
| `Unknown API endpoint` after changing transport | Restart the Node process so it loads the current routes, then refresh the browser. |
| `EADDRINUSE` on port 5173 | Stop the existing server in its terminal, or set `PORT=5174` and open localhost on that port. |
| WebSocket fails before connecting | Check the Node log for the upstream handshake status. HTTP 502 indicates the deployment gateway rejected the upgrade. |
| WebSocket closes immediately | Inspect the close code in Events and deployment logs; verify the deployment supports `/chat/{session_id}/stream`. |
| Text arrives together at completion | Check deployment proxy buffering and the Flow's stream emission. Compare frame timestamps with browser receipt times in Events. |

The local relay forwards WebSocket frames as they arrive. Real-time text also requires the deployed Flow to emit chunks during generation. In a live Chrome test, the UI received 158 text chunks before turn completion, logged 192 event entries, and reconstructed the final response exactly. The first chunk reached the browser about 9 ms after its emission timestamp.
