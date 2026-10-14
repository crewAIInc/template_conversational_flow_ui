import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolEvent, endToolCalls } from '../src/tool-events.mjs';

const start = (id, query) => ({ id, type: 'mcp_tool_execution_started', data: { tool_name: 'firecrawl_search', server_name: 'mcp.firecrawl.dev', tool_args: { query } } });
const done = (id, started, result = 'Search findings') => ({ id, type: 'mcp_tool_execution_completed', data: { started_event_id: started, tool_name: 'firecrawl_search', result, execution_duration_ms: 3435.249 } });

test('real MCP start and completion become one native tool-call part and survive replay', () => {
  let parts = toolEvent([], start('search-1', 'crewai'));
  assert.equal(parts[0].type, 'tool-call');
  assert.equal(parts[0].toolName, 'firecrawl_search');
  assert.equal(parts[0].result, undefined);
  assert.deepEqual(parts[0].args, { query: 'crewai' });
  parts = toolEvent(parts, done('end-1', 'search-1'));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].result, 'Search findings');
  assert.equal(parts[0].artifact.server, 'mcp.firecrawl.dev');
  assert.equal(parts[0].artifact.duration, 3435.249);
  assert.equal(toolEvent(parts, start('search-1', 'crewai')), parts);
  assert.deepEqual(endToolCalls(parts), parts);
});

test('parallel calls to the same MCP tool complete independently by started event ID', () => {
  let parts = toolEvent([], start('search-1', 'crewai'));
  parts = toolEvent(parts, start('search-2', 'voice streaming'));
  parts = toolEvent(parts, done('end-2', 'search-2', 'Voice results'));
  assert.equal(parts[0].result, undefined);
  assert.equal(parts[1].result, 'Voice results');
  parts = endToolCalls(parts);
  assert.equal(parts[0].artifact.status, 'incomplete');
  assert.equal(parts[1].artifact.status, 'completed');
});

test('MCP failures and CrewAI tools settle without pretending to have successful results', () => {
  const failed = toolEvent(toolEvent([], start('search-1', 'crewai')), { id: 'failure', type: 'mcp_tool_execution_failed', data: { started_event_id: 'search-1', tool_name: 'firecrawl_search', error: 'Search timed out' } });
  assert.equal(failed[0].isError, true);
  assert.equal(failed[0].result, 'Search timed out');
  const begun = toolEvent([], { id: 'regular', type: 'tool_usage_started', data: { tool_name: 'calculator', tool_args: '2 + 2' } });
  const completed = toolEvent(begun, { id: 'regular-end', type: 'tool_usage_finished', data: { tool_name: 'calculator', output: 4 } });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].result, 4);
  assert.deepEqual(completed[0].args, { input: '2 + 2' });
  const structured = toolEvent([], { id: 'exa', type: 'tool_usage_started', data: { tool_name: 'exa_search_tool', tool_args: '{"search_query":"CrewAI GitHub repository"}' } });
  assert.equal(structured[0].args.search_query, 'CrewAI GitHub repository');
  assert.equal(structured[0].argsText, '{"search_query":"CrewAI GitHub repository"}');
  assert.equal(toolEvent([], { type: 'llm_stream_chunk', data: { chunk: 'text' } }), null);
});
