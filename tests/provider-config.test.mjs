import test from 'node:test';
import assert from 'node:assert/strict';
import { providerLaunch } from '../server/index.mjs';

test('provider credentials and Kimi effort stay isolated; invalid effort fails without fallback', () => {
  const values = {
    MOONSHOT_API_KEY: 'synthetic-kimi-key',
    DEEPSEEK_API_KEY: 'synthetic-deepseek-key',
    KIMI_MODEL: 'kimi-k3[1m]',
    DEEPSEEK_MODEL: 'deepseek-flash',
    KIMI_EFFORT: 'max',
    ANTHROPIC_API_KEY: 'synthetic-unrelated-key',
    ANTHROPIC_AUTH_TOKEN: 'synthetic-unrelated-token',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const config = { claudeBin: 'unused-test-binary', mode: 'read' };
    const kimi = providerLaunch('kimi', 'kimi-k3[1m]', config);
    const deepseek = providerLaunch('deepseek', 'deepseek-flash', config);
    const claude = providerLaunch('claude', null, config);
    assert.equal(kimi.env.ANTHROPIC_AUTH_TOKEN, values.MOONSHOT_API_KEY);
    assert.equal(kimi.env.ANTHROPIC_BASE_URL, 'https://api.moonshot.ai/anthropic');
    assert.equal(kimi.env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
    assert.equal(deepseek.env.ANTHROPIC_AUTH_TOKEN, values.DEEPSEEK_API_KEY);
    assert.equal(deepseek.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(deepseek.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
    assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(claude.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(claude.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(claude.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
    for (const launch of [kimi, deepseek, claude]) {
      for (const key of ['MOONSHOT_API_KEY', 'KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_MODEL', 'DEEPSEEK_MODEL', 'KIMI_EFFORT']) {
        assert.equal(launch.env[key], undefined, `${key} must not leak to a worker`);
      }
    }
    for (const effort of ['low', 'high', 'max']) {
      process.env.KIMI_EFFORT = effort;
      assert.equal(providerLaunch('kimi', 'kimi-k3[1m]', config).env.CLAUDE_CODE_EFFORT_LEVEL, effort);
    }
    process.env.KIMI_EFFORT = 'invalid';
    assert.match(providerLaunch('kimi', 'kimi-k3[1m]', config).error, /KIMI_EFFORT/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
