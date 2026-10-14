import React from 'react';
import { ToolCall } from './components/assistant-ui/elements/tool-call';

// CrewAI event fields -> the installed assistant-ui Element's public props.
export function ToolActivity({ part, open, onOpenChange }) {
  const running = part.result === undefined;
  const state = part.artifact?.status || (running ? 'running' : part.isError ? 'failed' : 'completed');
  const query = part.args?.query ?? part.args?.search_query;
  let result = part.result;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* Plain text tool output. */ } }
  const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  const resultText = running ? 'Waiting for the tool…' : output?.length > 12000 ? `${output.slice(0, 12000)}\n… Full payload available in Events.` : output ?? 'No output returned.';
  return <div className="aui-elements tool-activity" data-tool-status={state}>
    <ToolCall
      label={`${state === 'incomplete' ? 'Incomplete' : part.isError ? 'Failed' : 'Ran'} ${part.toolName}`}
      activeLabel={`Running ${part.toolName}`}
      query={typeof query === 'string' ? query : part.toolName}
      request={part.argsText}
      result={resultText}
      running={running}
      open={open}
      onOpenChange={onOpenChange}
      className={`min-w-0 max-w-none ${part.isError ? '[&_.text-emerald-500]:hidden' : ''}`}
    />
    {(part.artifact?.server || Number.isFinite(part.artifact?.duration)) && <p className="tool-activity-meta">
      {part.artifact.server && `MCP · ${part.artifact.server}`}
      {Number.isFinite(part.artifact.duration) && ` · ${(part.artifact.duration / 1000).toFixed(2)} seconds`}
    </p>}
  </div>;
}
