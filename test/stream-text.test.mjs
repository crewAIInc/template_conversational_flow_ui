import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textDelta } from '../src/stream-text.mjs';

test('actual deployment LLM chunks build text; normalized tokens take precedence without duplication', () => {
  const turn = {};
  let text = '';
  const receive = frame => {
    const delta = textDelta(frame, turn);
    if (delta) text = delta.replace ? delta.content : text + delta.content;
  };
  receive({ type: 'llm_stream_chunk', data: { chunk: 'S', call_id: 'actual-deployment-call' } });
  assert.equal(text, 'S');
  receive({ type: 'llm_stream_chunk', data: { chunk: 'SE_TEXT_OK' } });
  assert.equal(text, 'SSE_TEXT_OK');
  receive({ type: 'hook_dispatched', data: { chunk: 'ignored' } });
  receive({ type: 'llm_stream_chunk', data: { chunk: null, tool_call: {} } });
  assert.equal(text, 'SSE_TEXT_OK');
  receive({ type: 'token', data: { content: 'SSE_' } });
  receive({ type: 'llm_stream_chunk', data: { chunk: 'duplicate' } });
  receive({ type: 'token', data: { content: 'TEXT_OK' } });
  assert.equal(text, 'SSE_TEXT_OK');
});
