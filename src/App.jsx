import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime } from '@assistant-ui/react';
import Markdown from 'react-markdown';
import { textDelta } from './stream-text.mjs';
import crewaiLogo from './assets/crewai-logo.png';

const storageKey = 'crewai-flow-sessions';
function readSessions() {
  try {
    const sessions = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(sessions) ? sessions.filter(s => s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.id) && typeof s.title === 'string').slice(0, 20) : [];
  } catch { return []; }
}
function errorText(body) {
  const detail = body?.error ?? body?.detail ?? body?.message;
  return typeof detail === 'string' ? detail : detail?.message || detail?.code || 'The request could not be completed.';
}
async function api(path, method = 'GET', payload) {
  const response = await fetch(`/api${path}`, { method, ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new Error(errorText(body));
  return body;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export default function App() {
  const [sessions, setSessions] = useState(readSessions);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Checking deployment');
  const [error, setError] = useState('');
  const [activity, setActivity] = useState([]);
  const [showActivity, setShowActivity] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const active = useRef(null);
  const generation = useRef(0);
  const onNew = useCallback(async message => {
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    await sendMessage(text);
  }, [busy, ready, session, messages]);
  const convertMessage = useCallback((message, index) => ({
    id: message.key || message.id || `${session?.id || 'new'}:${index}`,
    role: message.role,
    content: [{ type: 'text', text: message.content || '' }],
  }), [session?.id]);
  const runtime = useExternalStoreRuntime({
    messages: messages.filter(message => message.role === 'user' || message.role === 'assistant'),
    convertMessage, onNew, isRunning: busy, isSendDisabled: !ready,
  });

  useEffect(() => {
    checkDeployment();
    return () => { generation.current++; if (active.current) { active.current.terminal = true; active.current.source?.close(); } };
  }, []);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(sessions)); } catch { /* Chat still works when storage is unavailable. */ } }, [sessions]);
  useEffect(() => {
    if (draft) { runtime.thread.composer.setText(draft); setDraft(''); }
  }, [draft, runtime]);

  async function checkDeployment() {
    setStatus('Checking deployment'); setError('');
    try {
      const result = await api('/inspect');
      if (!result.chat?.conversational || !result.chat?.handle_turn) throw new Error('This deployment does not support conversational chat. Enable conversational and handle_turn on the Flow.');
      setReady(true); setStatus('Ready');
      return true;
    } catch (error) { setReady(false); setStatus('Unavailable'); setError(error.message); return false; }
  }
  function log(type, detail = '') {
    setActivity(previous => [...previous, { type, detail, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }), key: crypto.randomUUID() }]);
  }
  function freshChat() {
    generation.current++;
    if (active.current) { active.current.terminal = true; active.current.source?.close(); }
    active.current = null;
    setSession(null); setMessages([]); setActivity([]); setDraft(''); setMobileMenu(false);
    if (ready) { setError(''); setStatus('Ready'); }
    runtime.thread.composer.setText('');
  }
  async function openSession(item, preserveDraft = false) {
    const currentGeneration = ++generation.current;
    if (active.current) { active.current.terminal = true; active.current.source?.close(); }
    active.current = null;
    if (!preserveDraft) runtime.thread.composer.setText('');
    setSession(item); setMessages([]); setActivity([]); setError(''); setBusy(true); setStatus('Loading history'); setMobileMenu(false);
    try {
      const history = await api(`/chat/${item.id}/history`);
      if (generation.current !== currentGeneration) return;
      setMessages(history.messages || []); setReady(true);
      if (history.active_kickoff_id) startStream(item.id, null, currentGeneration);
      else { setBusy(false); setStatus('Ready'); }
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      setError(error.message); setBusy(false); setReady(false); setStatus('Disconnected');
    }
  }
  async function finish(turn, failure) {
    turn.terminal = true;
    turn.source?.close();
    if (generation.current !== turn.generation) return;
    setStatus('Syncing history');
    try {
      let history;
      for (let attempt = 0; attempt < 5; attempt++) {
        history = await api(`/chat/${turn.id}/history`);
        if (!history.active_kickoff_id) break;
        await delay(500);
      }
      if (generation.current !== turn.generation) return;
      if (history.active_kickoff_id) throw new Error('The turn is still active. Reconnect to continue receiving updates.');
      setMessages(history.messages || []);
      setStatus('Ready');
    } catch (error) { if (generation.current === turn.generation) { setError(error.message); setReady(false); setStatus('Disconnected'); } }
    if (generation.current === turn.generation) {
      setBusy(false);
      if (failure) { setError(failure); setReady(false); setStatus('Disconnected'); if (turn.message) setDraft(turn.message); }
    }
  }
  function startStream(id, message, currentGeneration) {
    const turn = { id, message, generation: currentGeneration, previousUsers: messages.filter(m => m.role === 'user').length, terminal: false, retries: 0, sent: false, lastId: '0-0', seen: new Set(), assistant: crypto.randomUUID() };
    active.current = turn;
    setBusy(true);
    connect(turn);
  }
  async function connect(turn) {
    if (generation.current !== turn.generation || turn.terminal) return;
    try {
      if (turn.message && !turn.sent) {
        setStatus('Queuing turn');
        // Mark the attempt before sending; an uncertain HTTP result must not resend.
        turn.sent = true;
        const queued = await api(`/chat/${turn.id}/message`, 'POST', { message: turn.message, stream: true });
        if (turn.terminal || generation.current !== turn.generation) return;
        log('turn_queued', queued);
      }
      setStatus(turn.retries ? 'Reconnecting SSE' : 'Connecting SSE');
      const source = new EventSource(`/api/chat/${turn.id}/stream/events?events=*&last_event_id=${encodeURIComponent(turn.lastId)}`);
      turn.source = source;
      source.onopen = () => {
        if (turn.terminal || generation.current !== turn.generation) { source.close(); return; }
        setStatus('Connected · SSE');
        log('sse_connected', { last_event_id: turn.lastId });
      };
      source.onmessage = event => {
        if (turn.terminal || generation.current !== turn.generation) return;
        let frame;
        try { frame = JSON.parse(event.data); }
        catch { log('invalid_frame', event.data); setError('The deployment sent an invalid stream frame.'); return; }
        const eventId = frame.stream_id || frame.id || frame.event_id || event.lastEventId;
        if (typeof eventId === 'string' && /^\d+-\d+$/.test(eventId)) {
          if (turn.seen.has(eventId)) return;
          turn.seen.add(eventId); turn.lastId = eventId;
        }
        // Keep the complete payload of every frame, including individual tokens.
        log(frame.type || event.type || 'event', frame);
        const delta = textDelta(frame, turn);
        if (delta) {
          const { content, replace } = delta;
          setStatus('Streaming · SSE');
          setMessages(previous => {
            const index = previous.findIndex(m => m.key === turn.assistant);
            if (index < 0) return [...previous, { role: 'assistant', content, key: turn.assistant }];
            return previous.map((m, i) => i === index ? { ...m, content: replace ? content : m.content + content } : m);
          });
        }
        if (frame.type === 'turn_started') { setStatus('Thinking'); setError(''); }
        if (frame.type === 'turn_completed') finish(turn);
        if (frame.type === 'turn_failed' || frame.type === 'error') finish(turn, errorText(frame.data || frame));
      };
      source.onerror = () => {
        source.close(); // We control reconnects and inspect history before reattaching.
        recover(turn);
      };
    } catch (error) { recover(turn, error.message); }
  }
  async function recover(turn, failure) {
    if (turn.terminal || generation.current !== turn.generation) return;
    log('sse_disconnected', failure || 'Checking whether the turn is still active.');
    setStatus('Checking turn');
    try {
      await delay(500 * (turn.retries + 1));
      const history = await api(`/chat/${turn.id}/history`);
      if (turn.terminal || generation.current !== turn.generation) return;
      if (!history.active_kickoff_id) {
        const users = (history.messages || []).filter(m => m.role === 'user');
        if (!turn.message || (users.length > turn.previousUsers && users.at(-1)?.content === turn.message)) {
          log('history_synced', 'The turn finished. Final history is authoritative.');
          return finish(turn);
        }
        throw new Error(failure || 'The stream closed before the turn was confirmed. Your message is restored below.');
      }
      if (++turn.retries > 3) throw new Error('The SSE stream disconnected repeatedly. Reconnect to attach to the active turn.');
      connect(turn);
    } catch (error) {
      if (generation.current !== turn.generation || turn.terminal) return;
      turn.terminal = true; setBusy(false); setReady(false); setStatus('Disconnected'); setError(error.message);
      if (turn.message) setDraft(turn.message);
    }
  }
  async function sendMessage(text) {
    const message = text.trim();
    if (!message || busy || !ready) return;
    const currentGeneration = ++generation.current;
    setBusy(true); setError(''); setStatus('Starting session');
    try {
      let current = session;
      if (!current) {
        const result = await api('/chat/start', 'POST');
        if (!result.session_id) throw new Error('CrewAI did not return a session ID.');
        current = { id: result.session_id, title: message.slice(0, 48), created: new Date().toISOString() };
        setSession(current); setSessions(previous => [current, ...previous].slice(0, 20));
        log('session_created', current.id);
      } else {
        const history = await api(`/chat/${current.id}/history`);
        setMessages(history.messages || []);
        if (history.active_kickoff_id) {
          startStream(current.id, null, currentGeneration);
          return;
        }
      }
      setDraft(''); setMessages(previous => [...previous, { role: 'user', content: message, key: crypto.randomUUID() }]);
      startStream(current.id, message, currentGeneration);
    } catch (error) { setDraft(message); setError(error.message); setBusy(false); setReady(false); setStatus('Disconnected'); }
  }
  async function reconnect() {
    if (await checkDeployment()) {
      if (session) await openSession(session, true);
    }
  }

  return <AssistantRuntimeProvider runtime={runtime}><div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    {mobileMenu && <button className="menu-scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'is-open' : ''}`} aria-label="Conversations">
      <div className="sidebar-header"><a className="brand" href="/" aria-label="CrewAI chat home"><img src={crewaiLogo} alt="CrewAI" width="375" height="114" /></a><button className="icon-button collapse-button" aria-label="Collapse sidebar" onClick={() => setSidebarCollapsed(true)}><Icon name="sidebar" /></button></div>
      <div className="sidebar-content">
        <button className="new-chat" onClick={freshChat} disabled={busy}><Icon name="plus" /> New thread</button>
        {!!sessions.length && <div className="sidebar-heading">Recent chats</div>}
        <nav className="conversation-list">
          {sessions.map(item => <button key={item.id} className={`conversation ${session?.id === item.id ? 'selected' : ''}`} disabled={busy} onClick={() => openSession(item)}>{item.title}</button>)}
        </nav>
      </div>
      <div className="sidebar-bottom"><span className={`status-dot ${ready ? 'green' : ''}`} /><span>{ready ? 'CrewAI conversational flow' : 'Deployment unavailable'}</span></div>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <button className="icon-button menu-button" aria-label="Open navigation" onClick={() => { setSidebarCollapsed(false); setMobileMenu(true); }}><Icon name="sidebar" /></button>
        <h1>{session?.title || 'New chat'}</h1>
        <button className={`quiet-button ${showActivity ? 'is-active' : ''}`} onClick={() => setShowActivity(!showActivity)} aria-expanded={showActivity}>Events{activity.length ? ` (${activity.length})` : ''}</button>
      </header>
      <div className="workspace-body">
        <ThreadPrimitive.Root className={`chat-pane ${!messages.length && !busy ? 'empty-thread' : ''}`} aria-label="Flow chat" key={session?.id || 'new-conversation'}>
          <ThreadPrimitive.Viewport className="transcript" role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions text">
            {!messages.length && !busy && <div className="welcome"><h2>How can I help you today?</h2></div>}
            <div className="message-list">
              <ThreadPrimitive.Messages>{({ message }) => <ChatMessage role={message.role} />}</ThreadPrimitive.Messages>
              {busy && <div className="thinking" role="status"><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span><span>{status === 'Streaming · SSE' ? 'Receiving response' : status === 'Thinking' ? 'Thinking…' : status}</span></div>}
            </div>
          </ThreadPrimitive.Viewport>
          <div className="composer-area">
            {error && <div className="error-banner" role="alert"><div><strong>Connection interrupted</strong><p>{error}</p></div><button onClick={reconnect} disabled={busy}>Reconnect</button></div>}
            <ThreadPrimitive.ScrollToBottom className="scroll-to-bottom" aria-label="Scroll to latest message"><Icon name="down" /></ThreadPrimitive.ScrollToBottom>
            <ComposerPrimitive.Root className="composer">
              <label htmlFor="message" className="sr-only">Message your flow</label>
              <ComposerPrimitive.Input id="message" maxLength={32000} rows={2} placeholder="Send a message…" disabled={busy} />
              <div className="composer-bottom"><span>CrewAI Flow</span><ComposerPrimitive.Send className="send-button" aria-label="Send message"><Icon name="up" /></ComposerPrimitive.Send></div>
            </ComposerPrimitive.Root>
            {!messages.length && !busy && <div className="suggestions">
              {['What can you help me with?', 'Help me think through an idea.', 'Help me make a plan.'].map(prompt => <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} disabled={!ready}>{prompt}</ThreadPrimitive.Suggestion>)}
            </div>}
            {!!messages.length && <p className="composer-hint">AI responses can make mistakes. Check important information.</p>}
          </div>
        </ThreadPrimitive.Root>
        {showActivity && <aside className="activity-panel" aria-label="Runtime activity"><div className="activity-header"><h2>All events ({activity.length})</h2><button className="icon-button" onClick={() => setShowActivity(false)} aria-label="Close activity"><Icon name="close" /></button></div><p className="activity-description">Every received frame, including response tokens. Times show when this browser received each event.</p><div className="stream-status"><span className={`status-dot ${ready && !error ? 'green' : ''}`} />{status}</div>{session && <div className="session-info"><span>Session ID</span><code>{session.id}</code></div>}<div className="event-list">{!activity.length && <div className="activity-empty">Send a message to see your flow’s events.</div>}{activity.map(item => <div className="event" key={item.key}><div><strong>{item.type.replaceAll('_', ' ')}</strong><time>{item.time}</time></div>{item.detail && <details><summary>View payload</summary><pre>{typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail, null, 2)}</pre></details>}</div>)}</div></aside>}
      </div>
    </main>
  </div></AssistantRuntimeProvider>;
}

function ChatMessage({ role }) {
  return <MessagePrimitive.Root className={`message ${role}`}>
    <div className="message-body">
      <MessagePrimitive.Parts>{({ part }) => part.type === 'text' ? <div className="markdown"><Markdown components={{ a: props => <a {...props} target="_blank" rel="noreferrer" /> }}>{part.text}</Markdown></div> : null}</MessagePrimitive.Parts>
      {role === 'assistant' && <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="message-actions"><ActionBarPrimitive.Copy className="icon-button copy-button" aria-label="Copy response"><span className="copy-icon"><Icon name="copy" /></span><span className="copied-icon"><Icon name="check" /></span></ActionBarPrimitive.Copy></ActionBarPrimitive.Root>}
    </div>
  </MessagePrimitive.Root>;
}

function Icon({ name }) {
  const paths = {
    chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.5Z',
    plus: 'M12 5v14M5 12h14', up: 'M12 19V5M5 12l7-7 7 7', down: 'M12 5v14M5 12l7 7 7-7',
    sidebar: 'M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
    close: 'm6 6 12 12M6 18 18 6', copy: 'M9 9h12v12H9zM5 15H3V3h12v2', check: 'm5 12 4 4L19 6',
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
