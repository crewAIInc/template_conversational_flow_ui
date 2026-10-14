import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { toolEvent } from '../src/tool-events.mjs';

test('tool message parts render through the installed Element with accessible disclosure and escaped output', async () => {
  const file = new URL(`../.element-check-${process.pid}.mjs`, import.meta.url);
  const result = await build({ entryPoints: ['src/ToolActivity.jsx'], bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'jsconfig.json', jsx: 'automatic', write: false });
  await writeFile(file, result.outputFiles[0].text);
  try {
    const { ToolActivity } = await import(file.href);
    const [part] = toolEvent([], { type: 'mcp_tool_execution_completed', id: 'done', data: { tool_name: 'search', tool_args: { query: 'crewai' }, result: '<script>alert(1)</script>' } });
    const html = renderToStaticMarkup(React.createElement(ToolActivity, { part, open: true, onOpenChange() {} }));
    assert.match(html, /data-slot="tool-call"/);
    assert.match(html, /<button[^>]*aria-expanded="true"/);
    assert.match(html, /data-slot="collapsible-trigger"/);
    assert.match(html, /Request/);
    assert.match(html, /Result/);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
  } finally { await unlink(file); }
});
