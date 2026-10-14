// Some deployments publish raw LLM chunks instead of normalized token frames.
// Prefer normalized response tokens if both formats appear in the same turn.
export function textDelta(frame, turn) {
  const source = frame.type;
  if (source === 'conversation_message_added' && frame.data?.role === 'assistant' && typeof frame.data.content === 'string') {
    turn.textSource = 'message';
    return { content: frame.data.content, replace: true };
  }
  if (turn.textSource === 'message') return null;
  const content = source === 'token' ? frame.data?.content
    : source === 'llm_stream_chunk' ? frame.data?.chunk : undefined;
  if (typeof content !== 'string' || !content) return null;
  if (source === 'llm_stream_chunk' && turn.textSource === 'token') return null;
  const replace = source === 'token' && turn.textSource === 'llm_stream_chunk';
  turn.textSource = source;
  return { content, replace };
}
