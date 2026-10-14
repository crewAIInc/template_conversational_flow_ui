const starts = new Set(['mcp_tool_execution_started', 'tool_usage_started']);
const finishes = new Set(['mcp_tool_execution_completed', 'tool_usage_finished']);
const failures = new Set(['mcp_tool_execution_failed', 'tool_usage_error']);

// Correlate invocations by event ID, so parallel calls to one tool stay separate.
export function toolEvent(parts, frame) {
  if (!starts.has(frame.type) && !finishes.has(frame.type) && !failures.has(frame.type)) return null;
  const data = frame.data || {};
  if (typeof data.tool_name !== 'string' || !data.tool_name) return null;
  let id = data.started_event_id || data.tool_call_id || frame.id || frame.stream_id;
  if (!id) return null;
  if (!starts.has(frame.type) && !data.started_event_id && !data.tool_call_id) {
    const pending = parts.filter(part => part.toolName === data.tool_name && part.result === undefined && part.artifact.server === (data.server_name || ''));
    if (pending.length === 1) id = pending[0].toolCallId;
  }
  const old = parts.find(part => part.toolCallId === id);
  // A replayed start must not turn a completed call back into a running call.
  if (starts.has(frame.type) && old) return parts;
  const args = data.tool_args ?? old?.args ?? {};
  const failed = failures.has(frame.type) || Boolean(data.failure);
  const part = {
    type: 'tool-call', toolCallId: id, toolName: data.tool_name,
    args: typeof args === 'object' && args !== null && !Array.isArray(args) ? args : { input: args },
    argsText: typeof args === 'string' ? args : JSON.stringify(args, null, 2),
    artifact: { server: data.server_name || old?.artifact.server || '', duration: data.execution_duration_ms, status: starts.has(frame.type) ? 'running' : failed ? 'failed' : 'completed' },
    ...(!starts.has(frame.type) ? { result: failed ? data.error ?? data.failure ?? 'The tool failed.' : data.result ?? data.output ?? null, isError: failed } : {}),
  };
  return old ? parts.map(item => item.toolCallId === id ? part : item) : [...parts, part];
}

export function endToolCalls(parts) {
  return parts.map(part => part.result === undefined ? { ...part, isError: true, result: 'The turn ended without a completion event for this tool.', artifact: { ...part.artifact, status: 'incomplete' } } : part);
}
