import test from 'node:test';
import assert from 'node:assert/strict';
import { outOfScope } from '../server/index.mjs';

const edit = (allowedPaths) => ({ mode: 'edit', allowedPaths });

test('"dir/**" covers every file under dir at any depth', () => {
  assert.deepEqual(outOfScope([
    'src/components/app/AppFrame.tsx',
    'src/app/api/worker-status/route.ts',
    'src/app/layout.tsx',
  ], edit(['src/components/app/**', 'src/app/api/worker-status/**', 'src/app/layout.tsx'])), []);
  assert.deepEqual(outOfScope([
    'src/app/kit/page.tsx',
    'src/components/kit/board.tsx',
    'src/components/kit/deep/nested/card.tsx',
    'tsconfig.json',
  ], edit(['src/app/kit/**', 'src/components/kit/**', 'tsconfig.json'])), []);
});

test('Next.js bracket and group folders match literally', () => {
  assert.deepEqual(outOfScope([
    'src/app/agents/[slug]/page.tsx',
    'src/app/(board)/cards/[id]/page.tsx',
    'src/app/runs/[runId]/page.tsx',
  ], edit(['src/app/agents/**', 'src/app/(board)/cards/[id]/**', 'src/app/runs/[runId]/page.tsx'])), []);
  assert.deepEqual(outOfScope(['src/app/agents/s/page.tsx'], edit(['src/app/agents/[slug]/**'])),
    ['src/app/agents/s/page.tsx'], 'brackets are not a character class');
});

test('files outside the allowed globs are still flagged', () => {
  assert.deepEqual(outOfScope([
    'src/components/app/AppFrame.tsx',
    'src/components/application.tsx',
    'src/components/apple/x.tsx',
    'src/components/AppFrame.tsx',
    'src/app/page.tsx',
    'package.json',
  ], edit(['src/components/app/**'])), [
    'src/components/application.tsx',
    'src/components/apple/x.tsx',
    'src/components/AppFrame.tsx',
    'src/app/page.tsx',
    'package.json',
  ]);
});

test('single-star, question-mark and leading/middle "**" globs', () => {
  const run = edit(['src/lib/*.ts', 'docs/v?.md', '**/*.test.ts', 'worker/**/hooks.ts']);
  assert.deepEqual(outOfScope([
    'src/lib/costs.ts',
    'src/lib/engines/claude.ts',
    'docs/v1.md',
    'docs/v10.md',
    'state.test.ts',
    'src/lib/deep/state.test.ts',
    'worker/hooks.ts',
    'worker/a/b/hooks.ts',
    'worker/hooks.tsx',
  ], run), ['src/lib/engines/claude.ts', 'docs/v10.md', 'worker/hooks.tsx']);
});

test('exact files and plain directory prefixes keep working', () => {
  assert.deepEqual(outOfScope(['src/ok.txt', 'src', 'srcx/a.txt', 'other.txt'], edit(['src/'])), ['srcx/a.txt', 'other.txt']);
  assert.deepEqual(outOfScope(['tsconfig.json', 'tsconfig.json.bak'], edit(['tsconfig.json'])), ['tsconfig.json.bak']);
  assert.deepEqual(outOfScope(['a.txt'], { mode: 'read' }), ['a.txt'], 'read runs flag every change');
  assert.deepEqual(outOfScope(['a.txt'], { mode: 'edit' }), [], 'no allowedPaths means no scope check');
});
