import test from 'node:test';
import assert from 'node:assert/strict';
import { readableEventContent } from '../server/index.mjs';

test('activity shows tool actions and nested results without object coercion or private thinking', () => {
  assert.equal(readableEventContent([
    { type: 'thinking', thinking: 'private reasoning' },
    { type: 'tool_use', name: 'Read', input: { file_path: 'src/App.tsx' } },
    { type: 'tool_result', content: [{ type: 'text', text: 'file contents' }] },
  ]), 'Using Read: src/App.tsx\nTool finished: file contents');
  assert.equal(readableEventContent({ type: 'tool_result', is_error: true, content: 'Missing file' }), 'Tool error: Missing file');
  assert.equal(readableEventContent({ unknown: 'opaque' }), '');
});
