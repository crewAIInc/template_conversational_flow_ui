import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageDetails, timingStats } from '../src/message-details.mjs';

test('explicit reasoning streams separately from answer text and settles on answer or failure', () => {
  let details = messageDetails({}, { type: 'llm_thinking_chunk', data: { call_id: 'a', chunk: 'Check ' } });
  details = messageDetails(details, { type: 'llm_thinking_chunk', data: { call_id: 'a', chunk: 'the source.' } });
  assert.equal(details.reasoning[0].text, 'Check the source.');
  assert.equal(details.reasoning[0].status.type, 'running');
  details = messageDetails(details, { type: 'llm_stream_chunk' }, undefined, true);
  assert.equal(details.reasoning[0].status.type, 'complete');
  details = messageDetails(details, { type: 'agent_reasoning_completed', data: { task_id: 'task', plan: 'Search primary sources.' } });
  assert.equal(details.reasoning[1].text, 'Search primary sources.');
  assert.equal(details.reasoning[1].status.type, 'complete');
  assert.equal(messageDetails({}, { type: 'tool_usage_started', data: { tool_name: 'search' } }).reasoning, undefined);
  details = messageDetails(details, { type: 'llm_thinking_chunk', data: { call_id: 'b', chunk: 'Another step.' } });
  details = messageDetails(details, { type: 'turn_failed' });
  assert.equal(details.reasoning[0].status.type, 'complete');
  assert.equal(details.reasoning.at(-1).status.type, 'incomplete');
  details = messageDetails(details, { type: 'llm_call_completed' });
  assert.equal(details.reasoning.at(-1).status.type, 'incomplete');
});

test('source metadata is deduplicated and unsafe URLs or arbitrary prose are excluded', () => {
  let details = messageDetails({}, { type: 'mcp_tool_execution_completed', data: { result: { results: [
    { title: 'Docs', url: 'https://docs.crewai.com' }, { url: 'javascript:alert(1)' }, { url: 'https://name:secret@example.com/' }, null,
  ] } } });
  assert.equal(details.sources.length, 1);
  details = messageDetails(details, { type: 'sources', data: { sources: [{ title: 'CrewAI docs', url: 'https://docs.crewai.com/' }] } });
  assert.equal(details.sources.length, 1);
  assert.equal(details.sources[0].title, 'CrewAI docs');
  details = messageDetails(details, { type: 'tool_usage_finished', data: { tool_name: 'exa_search_tool', output: 'Title: CrewAI\nURL: https://crewai.com/\nText: A search result' } });
  assert.equal(details.sources.length, 2);
  assert.equal(messageDetails({}, { type: 'llm_stream_chunk', data: { chunk: 'See https://example.com/' } }).sources, undefined);
});

test('browser elapsed timings retain the first event and text and omit unknown resumed timings', () => {
  let details = messageDetails({}, { type: 'turn_queued' }, 100);
  details = messageDetails(details, { type: 'turn_started', data: { status: 'queued' } }, 200);
  details = messageDetails(details, { type: 'turn_started' }, 350);
  details = messageDetails(details, { type: 'llm_stream_chunk' }, 1200, true);
  details = messageDetails(details, { type: 'llm_stream_chunk' }, 1300, true);
  details = messageDetails(details, { type: 'turn_completed' }, 1500);
  assert.deepEqual(details.timing, { firstEvent: 100, turnStarted: 350, firstText: 1200, total: 1500 });
  assert.deepEqual(timingStats(details.timing).map(stat => stat.value), ['100ms', '350ms', '1.20s', '1.50s']);
  assert.deepEqual(timingStats(messageDetails({}, { type: 'turn_completed' }).timing), []);
});
