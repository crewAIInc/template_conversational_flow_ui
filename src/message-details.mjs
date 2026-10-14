// Only display reasoning and references explicitly supplied by the deployment.
export function messageDetails(previous = {}, frame, elapsed, hasText = false) {
  const data = frame.data || {};
  const next = { ...previous };
  if (Number.isFinite(elapsed)) {
    next.timing = { ...previous.timing };
    next.timing.firstEvent ??= elapsed;
    if (frame.type === 'turn_started' && data.status !== 'queued') next.timing.turnStarted ??= elapsed;
    if (hasText) next.timing.firstText ??= elapsed;
    if (frame.type === 'turn_completed' || frame.type === 'turn_failed') next.timing.total ??= elapsed;
  }
  const thinking = frame.type === 'llm_thinking_chunk' && typeof data.chunk === 'string';
  const plan = frame.type === 'agent_reasoning_completed' && typeof data.plan === 'string';
  if (thinking || plan) {
    const id = plan ? `plan:${data.task_id || data.agent_id || 'agent'}:${data.attempt || 1}` : `thinking:${data.call_id || data.response_id || 'llm'}`;
    const parts = previous.reasoning || [];
    const old = parts.find(part => part.id === id);
    const part = { type: 'reasoning', id, text: plan ? data.plan : (old?.text || '') + data.chunk, status: { type: plan ? 'complete' : 'running' } };
    next.reasoning = old ? parts.map(item => item.id === id ? part : item) : [...parts, part];
  } else if (hasText || ['llm_call_completed', 'llm_call_failed', 'turn_completed', 'turn_failed'].includes(frame.type)) {
    const failed = frame.type.endsWith('failed');
    next.reasoning = (previous.reasoning || []).map(part => part.status.type === 'running' ? { ...part, status: failed ? { type: 'incomplete', reason: 'error' } : { type: 'complete' } } : part);
  }
  let sourceData = frame.type === 'source' ? [data] : frame.type === 'sources' ? data.sources : undefined;
  if (['mcp_tool_execution_completed', 'tool_usage_finished'].includes(frame.type)) {
    let result = data.result ?? data.output;
    if (typeof result === 'string') {
      try { result = JSON.parse(result); }
      catch {
        // ExaSearchTool's documented output uses explicit Title/URL metadata rows.
        if (data.tool_name === 'exa_search_tool') sourceData = [...result.matchAll(/(?:^|\n)Title: ([^\n]+)\nURL: (https?:\/\/[^\s]+)/g)].map(match => ({ title: match[1], url: match[2] }));
      }
    }
    sourceData ??= Array.isArray(result) ? result : result?.sources ?? result?.results;
  }
  if (Array.isArray(sourceData)) {
    const sources = new Map((previous.sources || []).map(source => [source.url, source]));
    for (const source of sourceData) {
      if (!source || typeof source.url !== 'string') continue;
      let url;
      try { url = new URL(source.url); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      sources.set(url.href, { url: url.href, title: typeof source.title === 'string' ? source.title : url.hostname, snippet: typeof source.snippet === 'string' ? source.snippet : undefined });
    }
    next.sources = [...sources.values()];
  }
  return next;
}

export function timingStats(timing = {}) {
  return [['First event', timing.firstEvent], ['Turn started', timing.turnStarted], ['First text', timing.firstText], ['Total', timing.total]]
    .filter(([, value]) => Number.isFinite(value))
    .map(([label, value]) => ({ label, value: value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s` }));
}
