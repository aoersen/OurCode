#!/usr/bin/env node
/**
 * Smoke test for the vendored aioli MCP server.
 *
 * Verifies over stdio JSON-RPC:
 *   1. initialize handshake
 *   2. tools/list exposes the expected tools
 *   3. get_tokens resolves a semantic token
 *   4. generate_component produces a component offline
 *   5. stdout carries nothing but JSON-RPC (no log pollution)
 *
 * Usage: node mcp-servers/aioli-mcp/smoke-test.mjs
 * Exits 0 on success, 1 on failure.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, 'index.js');

const child = spawn(process.execPath, [serverPath], { cwd: resolve(__dirname, '..', '..') });
let buf = '';
let stderr = '';
const badLines = [];
const done = (ok, why) => {
  child.kill();
  if (ok) {
    console.log('SMOKE OK');
    process.exit(0);
  } else {
    console.error(`SMOKE FAIL: ${why}`);
    if (badLines.length) console.error('Non-JSON stdout lines:', badLines.slice(0, 5));
    process.exit(1);
  }
};
const timer = setTimeout(() => done(false, 'timeout'), 20000);

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

child.stderr.on('data', (d) => { stderr += d; });
child.stdout.on('data', (d) => {
  buf += d;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    let msg;
    try { msg = JSON.parse(l); } catch { badLines.push(l.slice(0, 80)); continue; }
    if (msg.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    else if (msg.id === 2) {
      const names = (msg.result.tools || []).map((t) => t.name);
      for (const required of ['generate_component', 'get_tokens', 'check_contrast']) {
        if (!names.includes(required)) return done(false, `tool missing: ${required}`);
      }
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_tokens', arguments: { path: 'semantic.color.primary.default' } } });
    } else if (msg.id === 3) {
      const text = msg.result.content[0].text;
      if (!text.includes('#2563eb')) return done(false, 'primary token did not resolve to #2563eb');
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'generate_component', arguments: { description: 'primary button with icon', output_format: 'html' } } });
    } else if (msg.id === 4) {
      const text = msg.result.content[0].text;
      if (!text.includes('<button')) return done(false, 'generate_component did not return a button');
      if (badLines.length) return done(false, 'stdout polluted by non-JSON lines');
      clearTimeout(timer);
      done(true);
    }
  }
});

child.on('exit', (code) => {
  if (code !== 0 && !stderr.includes('SMOKE')) {
    done(false, `server exited with code ${code}: ${stderr.slice(0, 300)}`);
  }
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } },
});
