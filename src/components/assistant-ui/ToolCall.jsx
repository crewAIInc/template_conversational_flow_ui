import React from 'react';

// assistant-ui Elements Tool Call, adapted to plain CSS and native disclosure.
// https://www.assistant-ui.com/elements/tool-call
export function ToolCall({ part, open, onOpenChange }) {
  const running = part.result === undefined;
  const state = part.artifact?.status || (running ? 'running' : part.isError ? 'failed' : 'completed');
  const label = `${running ? 'Running' : state === 'incomplete' ? 'Incomplete' : part.isError ? 'Failed' : 'Ran'} ${part.toolName}`;
  let result = part.result;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* Plain text tool output. */ } }
  const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return <details className="tool-call" data-slot="tool-call" data-status={state} open={open} onToggle={event => onOpenChange(event.currentTarget.open)}>
    <summary>
      <span className="tool-call-chevron" aria-hidden="true">›</span>
      <span className={running ? 'thinking-indicator-label' : ''}>{label}</span>
      {typeof part.args?.query === 'string' && <span className="tool-call-query" title={part.args.query}>{part.args.query}</span>}
      <span className="tool-call-state">{running ? 'Running' : state === 'incomplete' ? 'Incomplete' : part.isError ? 'Failed' : 'Completed'}</span>
    </summary>
    <div className="tool-call-content">
      {part.artifact?.server && <p className="tool-call-server">MCP · {part.artifact.server}</p>}
      <h3>Request</h3><pre>{part.argsText}</pre>
      <h3>{part.isError ? 'Error' : 'Result'}</h3><pre>{running ? 'Waiting for the tool…' : output?.length > 12000 ? `${output.slice(0, 12000)}\n… Full payload available in Events.` : output ?? 'No output returned.'}</pre>
      {Number.isFinite(part.artifact?.duration) && <p className="tool-call-duration">{(part.artifact.duration / 1000).toFixed(2)} seconds</p>}
    </div>
  </details>;
}
