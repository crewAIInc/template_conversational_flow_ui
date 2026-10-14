import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from '@assistant-ui/react';

test('chat renders safely with unavailable or malformed browser storage', async () => {
  const file = new URL(`../.render-check-${process.pid}.mjs`, import.meta.url);
  const result = await build({ entryPoints: [new URL('../src/App.jsx', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false, packages: 'external', tsconfig: 'jsconfig.json', jsx: 'automatic', loader: { '.png': 'dataurl' }, plugins: [{ name: 'ssr-css', setup(build) { build.onResolve({ filter: /\.css$/ }, () => ({ path: 'data:text/javascript,', external: true })); build.onResolve({ filter: /elements\/syntax-highlighter$/ }, () => ({ path: new URL('../src/components/assistant-ui/elements/syntax-highlighter.tsx', import.meta.url).pathname, external: true })); } }] });
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored = 'invalid json';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => stored } });
  try {
    await writeFile(file, result.outputFiles[0].text);
    const { default: App, readSessions, ChatMessage } = await import(file.href);
    assert.deepEqual(readSessions('deployment-a'), []);
    let html = renderToStaticMarkup(React.createElement(App));
    assert.match(html, /How can I help you today\?/);
    assert.ok(!html.includes('aria-label="Generated code"'), 'a new chat starts without a static artifact pane');
    assert.match(html, /role="log" aria-label="Messages"/);
    assert.match(html, /<label[^>]*for="message"/);
    assert.ok(html.match(/<button[^>]+aria-label="Send message"[^>]*>/)?.[0].includes('disabled=""'));
    stored = JSON.stringify([
      null,
      { id: 'invalid', title: 'Invalid session' },
      { id: '11111111-2222-3333-4444-555555555555', title: '<script>alert(1)</script>' },
    ]);
    html = renderToStaticMarkup(React.createElement(App));
    assert.ok(!html.includes('Invalid session'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'history is not shown before the connected deployment is known');
    assert.equal(readSessions('deployment-a').length, 1);
    const histories = { 'deployment-a': stored, 'deployment-b': '[]' };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => histories[key] } });
    assert.equal(readSessions('deployment-a').length, 1);
    assert.deepEqual(readSessions('deployment-b'), []);
    assert.deepEqual(readSessions(), []);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage access denied'); } });
    assert.deepEqual(readSessions('deployment-a'), []);
    html = renderToStaticMarkup(React.createElement(App));
    assert.match(html, /How can I help you today\?/);
    function MessageCheck() {
      const details = { sources: [{ title: 'CrewAI docs', url: 'https://docs.crewai.com/' }], timing: { firstEvent: 50, firstText: 800, total: 1000 } };
      const runtime = useExternalStoreRuntime({ messages: [{ id: 'check', role: 'assistant', content: [
        { type: 'reasoning', text: 'Use a primary source.', status: { type: 'complete' } },
        { type: 'tool-call', toolCallId: 'search', toolName: 'search', args: {}, argsText: '{}', result: 'Found the docs' },
        { type: 'text', text: '```python\nprint("CHECK")\n```\n\n| Feature | Supported |\n| --- | --- |\n| Streaming | Yes |\n\n<script>alert(1)</script>' },
      ] }], convertMessage: message => message, onNew: async () => {} });
      return React.createElement(AssistantRuntimeProvider, { runtime }, React.createElement(ThreadPrimitive.Root, null,
        React.createElement(ThreadPrimitive.Viewport, null, React.createElement(ThreadPrimitive.Messages, null,
          () => React.createElement(ChatMessage, { role: 'assistant', details, artifacts: [{ id: 'code', line: 1, language: 'python', code: 'print("CHECK")', complete: true }], onOpen() {}, openTools: {}, onToolOpen() {} })))));
    }
    html = renderToStaticMarkup(React.createElement(MessageCheck));
    assert.match(html, /data-slot="reasoning-root"/);
    assert.match(html, /data-slot="tool-group-root"/);
    assert.match(html, /1 tool call/);
    assert.match(html, /data-slot="sources"/);
    assert.match(html, /First text/);
    assert.match(html, /800ms/);
    assert.match(html, /<table/);
    assert.equal((html.match(/aria-label="Open snippet.py"/g) || []).length, 1, 'one code artifact replaces the inline fence');
    assert.ok(!html.includes('<script>'));
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete globalThis.localStorage;
    await unlink(file);
  }
});
