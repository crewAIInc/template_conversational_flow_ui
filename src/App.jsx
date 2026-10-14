import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, groupPartByType, useExternalStoreRuntime } from '@assistant-ui/react';
import { MarkdownText } from './components/assistant-ui/elements/markdown-text';
import { ThreadList } from './components/assistant-ui/elements/thread-list';
import { ToolGroupRoot, ToolGroupTrigger, ToolGroupContent } from './components/assistant-ui/elements/tool-group.aui';
import { Reasoning, ReasoningRoot, ReasoningTrigger, ReasoningContent, ReasoningText } from './components/assistant-ui/elements/reasoning.aui';
import { Sources } from './components/assistant-ui/elements/sources';
import { MessageTiming } from './components/assistant-ui/elements/message-timing';
import { messageDetails, timingStats } from './message-details.mjs';
import { textDelta } from './stream-text.mjs';
import { connectChatStream, isCurrentTurnFrame } from './chat-stream.mjs';
import { codeArtifacts, artifactFilename } from './code-artifacts.mjs';
import { ThinkingIndicator } from './components/assistant-ui/elements/thinking-indicator';
import { ToolActivity } from './ToolActivity.jsx';
import { toolEvent, endToolCalls } from './tool-events.mjs';
import crewaiLogo from './assets/crewai-logo.png';

const SyntaxHighlighter = lazy(() => import('./components/assistant-ui/elements/syntax-highlighter').then(module => ({ default: module.SyntaxHighlighter })));

export function readSessions(storageKey) {
  if (!storageKey) return [];
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
  const [sessions, setSessions] = useState([]);
  const [deployment, setDeployment] = useState(null);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [toolCalls, setToolCalls] = useState({});
  const [details, setDetails] = useState({});
  const [openTools, setOpenTools] = useState({});
  const [draft, setDraft] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Checking deployment');
  const [error, setError] = useState('');
  const [activity, setActivity] = useState([]);
  const [showActivity, setShowActivity] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [mobilePane, setMobilePane] = useState('intent');
  const [selectedArtifact, setSelectedArtifact] = useState(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const autoArtifactStart = useRef(null);
  const autoArtifactSeen = useRef(null);
  const active = useRef(null);
  const connection = useRef({});
  const generation = useRef(0);
  const onNew = useCallback(async message => {
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    await sendMessage(text);
  }, [busy, ready, session, messages]);
  const convertMessage = useCallback((message, index) => ({
    id: message.key || message.id || `${session?.id || 'new'}:${index}`,
    role: message.role,
    content: [...(message.role === 'assistant' ? details[message.kickoff_id || message.key]?.reasoning || [] : []), ...(message.role === 'assistant' ? toolCalls[message.kickoff_id || message.key] || [] : []), { type: 'text', text: message.content || '' }],
    metadata: { custom: message.role === 'assistant' ? { ...details[message.kickoff_id || message.key], turnId: message.kickoff_id || message.key } : {} },
  }), [session?.id, toolCalls, details]);
  const chatMessages = useMemo(() => messages.filter(message => message.role === 'user' || message.role === 'assistant'), [messages]);
  const latestMessage = chatMessages.at(-1);
  const runningTool = latestMessage?.role === 'assistant' && toolCalls[latestMessage.kickoff_id || latestMessage.key]?.some(part => part.result === undefined);
  const artifacts = useMemo(() => chatMessages.flatMap((message, index) => message.role === 'assistant'
    ? codeArtifacts(message.content).map((artifact, artifactIndex) => ({ ...artifact, id: `${index}:${artifactIndex}`, messageIndex: index, messageId: convertMessage(message, index).id })) : []), [chatMessages, convertMessage]);
  const currentArtifact = artifacts.find(artifact => artifact.id === selectedArtifact);
  const paneOpen = outputOpen && Boolean(currentArtifact);
  const runtime = useExternalStoreRuntime({
    messages: chatMessages,
    convertMessage, onNew, isRunning: busy, isSendDisabled: !ready,
  });

  useEffect(() => {
    checkDeployment();
    return () => { generation.current++; releaseStream(); };
  }, []);
  useEffect(() => {
    if (!deployment) return;
    try { localStorage.setItem(`crewai-flow-sessions:${deployment.id}`, JSON.stringify(sessions)); } catch { /* Chat still works when storage is unavailable. */ }
  }, [sessions, deployment]);
  useEffect(() => {
    if (draft) { runtime.thread.composer.setText(draft); setDraft(''); }
  }, [draft, runtime]);
  useEffect(() => {
    if (autoArtifactStart.current === null) return;
    const artifact = artifacts.filter(item => item.messageIndex >= autoArtifactStart.current).at(-1);
    if (artifact && artifact.id !== autoArtifactSeen.current) {
      autoArtifactSeen.current = artifact.id;
      setSelectedArtifact(artifact.id); setOutputOpen(true);
    }
  }, [artifacts]);

  async function checkDeployment() {
    setStatus('Checking deployment'); setError('');
    try {
      const result = await api('/inspect');
      if (!result.chat?.conversational || !result.chat?.handle_turn) throw new Error('This deployment does not support conversational chat. Enable conversational and handle_turn on the Flow.');
      if (!result.deployment?.id || !result.deployment?.hostname) throw new Error('Restart the Node server to load the current deployment identity.');
      if (deployment?.id !== result.deployment.id) {
        freshChat();
        setSessions(readSessions(`crewai-flow-sessions:${result.deployment.id}`));
        setDeployment(result.deployment);
        log('deployment_connected', { hostname: result.deployment.hostname });
      }
      setReady(true); setStatus('Ready');
      return result.deployment.id;
    } catch (error) { setReady(false); setStatus('Unavailable'); setError(error.message); return false; }
  }
  function log(type, detail = '') {
    setActivity(previous => [...previous, { type, detail, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }), key: crypto.randomUUID() }]);
  }
  function releaseStream(nextId) {
    if (active.current) {
      active.current.terminal = true;
      if (active.current.transport !== 'WebSocket' || active.current.id !== nextId) active.current.source?.close();
    }
    if (connection.current.id !== nextId) {
      connection.current.source?.close(); connection.current = {};
    }
    active.current = null;
  }
  function freshChat() {
    generation.current++;
    releaseStream();
    setSession(null); setMessages([]); setToolCalls({}); setDetails({}); setOpenTools({}); setActivity([]); setDraft(''); setMobileMenu(false);
    setSelectedArtifact(null); setMobilePane('intent'); setShowActivity(false); setOutputOpen(false); autoArtifactStart.current = null; autoArtifactSeen.current = null;
    if (ready) { setError(''); setStatus('Ready'); }
    runtime.thread.composer.setText('');
  }
  async function openSession(item, preserveDraft = false) {
    const currentGeneration = ++generation.current;
    releaseStream(item.id);
    if (!preserveDraft) runtime.thread.composer.setText('');
    setSession(item); setMessages([]); setToolCalls({}); setDetails({}); setOpenTools({}); setActivity([]); setError(''); setBusy(true); setStatus('Loading history'); setMobileMenu(false);
    setSelectedArtifact(null); setMobilePane('intent'); setShowActivity(false); setOutputOpen(false); autoArtifactStart.current = null; autoArtifactSeen.current = null;
    try {
      const history = await api(`/chat/${item.id}/history`);
      if (generation.current !== currentGeneration) return;
      setMessages(history.messages || []); setReady(true);
      if (history.active_kickoff_id) startStream(item.id, null, currentGeneration, history.active_kickoff_id);
      else { setBusy(false); setStatus('Ready'); }
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      setError(error.message); setBusy(false); setReady(false); setStatus('Disconnected');
    }
  }
  async function finish(turn, failure) {
    turn.terminal = true;
    if (turn.transport !== 'WebSocket') turn.source?.close();
    if (generation.current !== turn.generation) return;
    turn.details = messageDetails(turn.details, { type: failure ? 'turn_failed' : 'turn_completed' }, turn.submittedAt === undefined ? undefined : performance.now() - turn.submittedAt);
    setDetails(previous => ({ ...previous, [turn.kickoffId || turn.assistant]: turn.details }));
    if (turn.tools?.length) setToolCalls(previous => ({ ...previous, [turn.kickoffId || turn.assistant]: endToolCalls(turn.tools) }));
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
  function startStream(id, message, currentGeneration, kickoffId, submittedAt) {
    const turn = { id, message, generation: currentGeneration, kickoffId, previousUsers: messages.filter(m => m.role === 'user').length, terminal: false, retries: 0, sent: false, lastId: '0-0', seen: new Set(), assistant: crypto.randomUUID(), submittedAt };
    active.current = turn;
    setBusy(true);
    connectChatStream(turn, {
      connection: connection.current,
      api, isCurrent: () => generation.current === turn.generation,
      status: setStatus, log, finish: () => finish(turn),
      fail: message => {
        setBusy(false); setReady(false); setStatus('Disconnected'); setError(message);
        if (turn.message) setDraft(turn.message);
      },
      onMessage: event => {
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
        // Ignore replayed frames and completion from earlier turns.
        if (!isCurrentTurnFrame(frame, turn)) return;
        const tools = toolEvent(turn.tools || [], frame);
        if (tools) {
          turn.tools = tools;
          setToolCalls(previous => ({ ...previous, [frame.kickoff_id || turn.kickoffId || turn.assistant]: tools }));
          setMessages(previous => previous.some(item => item.key === turn.assistant) ? previous : [...previous, { role: 'assistant', content: '', key: turn.assistant, kickoff_id: frame.kickoff_id || turn.kickoffId }]);
          const running = tools.find(part => part.result === undefined);
          setStatus(running ? `Running ${running.toolName}` : turn.textSource ? `Streaming · ${turn.transport}` : 'Thinking');
        }
        const delta = textDelta(frame, turn);
        turn.details = messageDetails(turn.details, frame, turn.submittedAt === undefined ? undefined : performance.now() - turn.submittedAt, Boolean(delta));
        setDetails(previous => ({ ...previous, [frame.kickoff_id || turn.kickoffId || turn.assistant]: turn.details }));
        if (turn.details.reasoning?.length) setMessages(previous => previous.some(item => item.key === turn.assistant) ? previous : [...previous, { role: 'assistant', content: '', key: turn.assistant, kickoff_id: frame.kickoff_id || turn.kickoffId }]);
        if (delta) {
          const { content, replace } = delta;
          setStatus(`Streaming · ${turn.transport}`);
          setMessages(previous => {
            const index = previous.findIndex(m => m.key === turn.assistant);
            if (index < 0) return [...previous, { role: 'assistant', content, key: turn.assistant, kickoff_id: frame.kickoff_id }];
            return previous.map((m, i) => i === index ? { ...m, content: replace ? content : m.content + content, kickoff_id: frame.kickoff_id || m.kickoff_id } : m);
          });
        }
        if (frame.type === 'turn_started') { setStatus('Thinking'); setError(''); }
        if (frame.type === 'turn_completed') finish(turn);
        if (frame.type === 'turn_failed' || frame.type === 'error') finish(turn, errorText(frame.data || frame));
      },
    });
  }
  async function sendMessage(text) {
    const submittedAt = performance.now();
    const message = text.trim();
    if (!message || busy || !ready) return;
    setShowActivity(false); autoArtifactStart.current = chatMessages.length; autoArtifactSeen.current = null;
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
          startStream(current.id, null, currentGeneration, history.active_kickoff_id);
          return;
        }
      }
      setDraft(''); setMessages(previous => [...previous, { role: 'user', content: message, key: crypto.randomUUID() }]);
      startStream(current.id, message, currentGeneration, undefined, submittedAt);
    } catch (error) { setDraft(message); setError(error.message); setBusy(false); setReady(false); setStatus('Disconnected'); }
  }
  async function reconnect() {
    const connectedId = await checkDeployment();
    if (connectedId && session && deployment?.id === connectedId) await openSession(session, true);
  }

  function openArtifact(id) { setSelectedArtifact(id); setOutputOpen(true); setMobilePane('output'); }
  function closeArtifact() { setOutputOpen(false); setMobilePane('intent'); }

  return <AssistantRuntimeProvider runtime={runtime}><div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    {mobileMenu && <button className="menu-scrim" aria-label="Dismiss navigation" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'is-open' : ''}`} aria-label="Conversations">
      <div className="sidebar-header"><a className="brand" href="/" aria-label="CrewAI chat home"><img src={crewaiLogo} alt="CrewAI" width="375" height="114" /></a><button className="icon-button collapse-button" aria-label={mobileMenu ? 'Close navigation' : 'Collapse sidebar'} onClick={() => mobileMenu ? setMobileMenu(false) : setSidebarCollapsed(true)}><Icon name={mobileMenu ? 'close' : 'sidebar'} /></button></div>
      <div className="sidebar-content">
        <button className="new-chat" onClick={freshChat} disabled={busy}><Icon name="plus" /> New thread</button>
        <div className="sidebar-heading">Recent chats <span>{sessions.length}</span></div>
        <nav className="conversation-list" aria-label="Recent chats">
          <fieldset className="thread-list-fieldset aui-elements" disabled={busy}>
            <ThreadList
              className="max-w-none [&>div:first-child]:hidden"
              threads={sessions.map(item => ({ ...item, time: item.created ? new Date(item.created).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '' }))}
              activeIndex={sessions.findIndex(item => item.id === session?.id)}
              onActiveIndexChange={index => openSession(sessions[index])}
            />
          </fieldset>
          {!sessions.length && <p className="history-empty">Your conversations will appear here after your first request.</p>}
        </nav>
      </div>
      <div className="sidebar-bottom"><div className="connection-state"><span className={`status-dot ${ready && !error ? 'green' : ''}`} /><span>{ready && !error ? 'Flow connected' : 'Deployment unavailable'}</span></div><span className="connection-caption" title={deployment?.hostname}>{deployment?.hostname || 'CrewAI conversational flow'}</span>{session && <details className="session-info"><summary>Session details</summary><code>{session.id}</code></details>}</div>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <button className="icon-button menu-button" aria-label="Open navigation" onClick={() => { setSidebarCollapsed(false); setMobileMenu(true); }}><Icon name="sidebar" /></button>
        <h1>{session?.title || 'New chat'}</h1>
        <div className={`workspace-status ${busy ? 'is-running' : ''}`} role="status"><span className={`status-dot ${ready && !error ? 'green' : ''}`} /><span>{status}</span></div>
        <button className={`quiet-button events-toggle ${showActivity ? 'is-active' : ''}`} aria-expanded={showActivity} onClick={() => { setShowActivity(!showActivity); setMobilePane('intent'); }}>Events{activity.length ? ` (${activity.length})` : ''}</button>
      </header>
      {error && <div className="error-banner" role="alert"><div><strong>Connection interrupted</strong><p>{error}</p></div><button onClick={reconnect} disabled={busy}>Reconnect</button></div>}
      {paneOpen && <nav className="mobile-panels" aria-label="Workspace panels"><button aria-pressed={mobilePane === 'intent'} onClick={() => setMobilePane('intent')}>Conversation</button><button aria-pressed={mobilePane === 'output'} onClick={() => setMobilePane('output')}>Code</button></nav>}
      <ThreadPrimitive.Root className={`workspace-body ${paneOpen ? 'has-output' : ''} mobile-${mobilePane}`} aria-label="Flow chat" key={session?.id || 'new-conversation'}>
        <section className={`chat-pane ${!messages.length && !busy ? 'empty-thread' : ''}`} aria-label="Conversation">
          {showActivity ? <section className="activity-panel" aria-label="Runtime activity"><div className="activity-header"><h2>Runtime activity</h2><button className="icon-button" aria-label="Close activity" onClick={() => setShowActivity(false)}><Icon name="close" /></button></div><p className="activity-description">Every received frame, including response tokens. Times show when this browser received each event.</p><div className="event-list">{!activity.length && <div className="activity-empty"><h3>No events yet</h3><p>Send a request to see your flow’s live activity.</p></div>}{activity.map(item => <div className="event" key={item.key}><div><strong>{item.type.replaceAll('_', ' ')}</strong><time>{item.time}</time></div>{item.detail && <details><summary>View payload</summary><pre>{typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail, null, 2)}</pre></details>}</div>)}</div></section> : <ThreadPrimitive.Viewport className="transcript" role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions text">
            {!messages.length && !busy && <div className="welcome"><h2>How can I help you today?</h2><p>Describe what you want to get done. Your flow will take it from there.</p></div>}
            <div className="message-list">
              <ThreadPrimitive.Messages>{({ message }) => {
                return <ChatMessage details={message.metadata?.custom} role={message.role} artifacts={artifacts.filter(artifact => artifact.messageId === message.id)} onOpen={openArtifact} openTools={openTools} onToolOpen={(id, open) => setOpenTools(previous => previous[id] === open ? previous : { ...previous, [id]: open })} />;
              }}</ThreadPrimitive.Messages>
              {busy && !runningTool && <ThinkingIndicator className="aui-elements py-3 text-xs" label={status.startsWith('Streaming ·') ? 'Receiving response' : status} role="status" aria-live="polite" aria-atomic="true" />}
            </div>
          </ThreadPrimitive.Viewport>}
          <div className="composer-area">
            <ThreadPrimitive.ScrollToBottom className="scroll-to-bottom" aria-label="Scroll to latest message"><Icon name="down" /></ThreadPrimitive.ScrollToBottom>
            <ComposerPrimitive.Root className="composer">
              <label htmlFor="message" className="sr-only">Message your flow</label>
              <ComposerPrimitive.Input id="message" maxLength={32000} rows={2} placeholder="Describe what you want to get done…" disabled={busy} />
              <div className="composer-bottom"><span>CrewAI Flow</span><ComposerPrimitive.Send className="send-button" aria-label="Send message"><Icon name="up" /></ComposerPrimitive.Send></div>
            </ComposerPrimitive.Root>
            {!messages.length && !busy && <div className="suggestions">
              {['What can you help me with?', 'Help me think through an idea.', 'Help me make a plan.'].map(prompt => <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} disabled={!ready}>{prompt}<span aria-hidden="true">↗</span></ThreadPrimitive.Suggestion>)}
            </div>}
            {!!messages.length && <p className="composer-hint">AI responses can make mistakes. Check important information.</p>}
          </div>
        </section>
        {paneOpen && <section className="output-pane" aria-label="Generated code">
          <CodeArtifact key={currentArtifact.id} artifact={currentArtifact} onClose={closeArtifact} />
        </section>}

      </ThreadPrimitive.Root>
    </main>
  </div></AssistantRuntimeProvider>;
}

export function ChatMessage({ details = {}, role, artifacts = [], onOpen, openTools, onToolOpen }) {
  return <MessagePrimitive.Root className={`message ${role}`}>
    <div className="message-body">
      <MessagePrimitive.GroupedParts groupBy={groupPartByType({ 'tool-call': ['group-tool'], reasoning: ['group-reasoning'] })}>
        {({ part, children }) => {
          if (part.type === 'group-tool') return <ToolGroupRoot className="aui-elements tool-group" variant="ghost" open={Boolean(openTools[`${details.turnId}:tools`])} onOpenChange={open => onToolOpen(`${details.turnId}:tools`, open)}>
            <ToolGroupTrigger count={part.indices.length} active={part.status.type === 'running'} />
            <ToolGroupContent>{children}</ToolGroupContent>
          </ToolGroupRoot>;
          if (part.type === 'group-reasoning') return <ReasoningRoot className="aui-elements" streaming={part.status.type === 'running'} open={openTools[`${details.turnId}:reasoning`]} onOpenChange={open => onToolOpen(`${details.turnId}:reasoning`, open)}>
            <ReasoningTrigger active={part.status.type === 'running'} />
            <ReasoningContent><ReasoningText>{children}</ReasoningText></ReasoningContent>
          </ReasoningRoot>;
          if (part.type === 'reasoning') return <Reasoning />;
          if (part.type === 'tool-call') return <ToolActivity part={part} open={Boolean(openTools[part.toolCallId])} onOpenChange={open => onToolOpen(part.toolCallId, open)} />;
          if (part.type !== 'text') return null;
          return <div className="markdown aui-elements"><MarkdownText
            components={{ a: props => <a {...props} target="_blank" rel="noreferrer" />, SyntaxHighlighter: HighlightedCode }}
            componentsByLanguage={Object.fromEntries(artifacts.map(artifact => [artifact.language, {
              CodeHeader: () => null,
              SyntaxHighlighter: props => {
                const match = artifacts.find(item => item.line === props.node?.position?.start.line);
                return match ? <button className="artifact-card" onClick={() => onOpen(match.id)} aria-label={`Open ${artifactFilename(match)}`}><span className="artifact-glyph" aria-hidden="true">{'</>'}</span><span className="artifact-card-info"><strong>{artifactFilename(match)}</strong><span>{match.complete ? `${match.code.split('\n').length} lines of code` : 'Streaming code…'}</span></span><span className="artifact-card-open" aria-hidden="true">Open ↗</span></button> : <HighlightedCode {...props} />;
              },
            }]))}
          /></div>;
        }}
      </MessagePrimitive.GroupedParts>
      {role === 'assistant' && <MessageExtras details={details} sourcesOpen={Boolean(openTools[`${details.turnId}:sources`])} onSourcesOpen={open => onToolOpen(`${details.turnId}:sources`, open)} />}
      {role === 'assistant' && <div className="message-actions"><ActionBarPrimitive.Root hideWhenRunning autohide="not-last"><ActionBarPrimitive.Copy className="icon-button copy-button" aria-label="Copy response"><span className="copy-icon"><Icon name="copy" /></span><span className="copied-icon"><Icon name="check" /></span></ActionBarPrimitive.Copy></ActionBarPrimitive.Root></div>}
    </div>
  </MessagePrimitive.Root>;
}

function HighlightedCode(props) {
  const { Pre, Code } = props.components;
  return <Suspense fallback={<Pre><Code>{props.code}</Code></Pre>}><SyntaxHighlighter {...props} /></Suspense>;
}

function MessageExtras({ details, sourcesOpen, onSourcesOpen }) {
  const stats = timingStats(details.timing);
  return <div className="aui-elements message-extras">
    {details.sources?.length > 0 && <Sources sources={details.sources} open={sourcesOpen} onOpenChange={onSourcesOpen} layout="list" className="max-w-none" />}
    {stats.length > 0 && <MessageTiming stats={stats} className="max-w-none" aria-label="Response timing from message send" />}
  </div>;
}

function CodeArtifact({ artifact, onClose }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(artifact.code);
      setCopyError(''); setCopied(true); clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 3000);
    } catch { setCopyError('Copy failed. Select the code to copy it manually.'); }
  }
  function downloadCode() {
    const url = URL.createObjectURL(new Blob([artifact.code], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = artifactFilename(artifact); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <>
    <header className="response-header"><div><h2>{artifactFilename(artifact)}</h2><p>{artifact.language || 'Code'}{!artifact.complete ? ' · Streaming' : ''}</p></div><button className="icon-button" aria-label="Close code" onClick={onClose}><Icon name="close" /></button></header>
    <div className="artifact-toolbar"><button className="quiet-button artifact-copy" onClick={copyCode} aria-label="Copy code" disabled={!artifact.code}><Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy code'}</button><button className="quiet-button" onClick={downloadCode} disabled={!artifact.complete}>Download</button><span>{artifact.code ? artifact.code.split('\n').length : 0} lines</span></div>
    {copyError && <p className="artifact-copy-error" role="alert">{copyError}</p>}
    <div className="artifact-code"><HighlightedCode language={artifact.language} code={artifact.code} components={{ Pre: "pre", Code: "code" }} /></div>
  </>;
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
