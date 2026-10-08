// Some deployments publish raw LLM chunks instead of normalized token frames.
// Prefer normalized response tokens if both formats appear in the same turn.
export function textDelta(frame, turn) {
  const source = frame.type;
  const content = source === 'token' ? frame.data?.content
    : source === 'llm_stream_chunk' ? frame.data?.chunk : undefined;
  if (typeof content !== 'string' || !content) return null;
  if (source === 'llm_stream_chunk' && turn.textSource === 'token') return null;
  const replace = source === 'token' && turn.textSource === 'llm_stream_chunk';
  turn.textSource = source;
  return { content, replace };
}
