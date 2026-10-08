import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('chat renders safely with unavailable or malformed browser storage', async () => {
  const file = new URL(`../.render-check-${process.pid}.mjs`, import.meta.url);
  const result = await build({ entryPoints: [new URL('../src/App.jsx', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false, packages: 'external', loader: { '.png': 'dataurl' } });
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored = 'invalid json';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => stored } });
  try {
    await writeFile(file, result.outputFiles[0].text);
    const { default: App } = await import(file.href);
    let html = renderToStaticMarkup(React.createElement(App));
    assert.match(html, /How can I help you today\?/);
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
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage access denied'); } });
    html = renderToStaticMarkup(React.createElement(App));
    assert.match(html, /How can I help you today\?/);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete globalThis.localStorage;
    await unlink(file);
  }
});
