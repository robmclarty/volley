/**
 * A stand-in `claude` binary for tests that drive the real engine
 * (`VOLLEY_CLAUDE_BIN`). It speaks just enough stream-json for fascicle's
 * `claude_cli` adapter: an init event, then a result.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FAKE_CLAUDE_MARKER = 'claude-was-here.txt';

/** What one call of the fake saw. */
export type FakeClaudeCall = {
  role: 'builder' | 'critic';
  argv: string[];
  env: Record<string, string>;
  cwd: string;
};

/** As the builder, it drops the marker into its working directory; as the
 * critic (`--json-schema` in its argv), it approves. Each call appends what it
 * saw to `calls.jsonl` beside the binary, outside any workspace. */
function fake_claude_source(calls: string): string {
  return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const is_critic = argv.includes('--json-schema');
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  role: is_critic ? 'critic' : 'builder',
  argv,
  env: process.env,
  cwd: process.cwd(),
}) + '\\n');
if (!is_critic) writeFileSync('${FAKE_CLAUDE_MARKER}', 'written by the fake builder\\n');
const result = is_critic
  ? JSON.stringify({ verdict: 'approved', feedback: 'looks done', unmet_criteria: [] })
  : 'wrote the marker';
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model' });
emit({
  type: 'result',
  subtype: 'success',
  session_id: 'fake-session',
  duration_ms: 1,
  total_cost_usd: 0,
  is_error: false,
  usage: { input_tokens: 0, output_tokens: 0 },
  result,
});
`;
}

export function install_fake_claude(): {
  bin: string;
  calls: () => FakeClaudeCall[];
  remove: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'volley-fake-claude-'));
  const bin = join(dir, 'claude.mjs');
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(calls, '');
  writeFileSync(bin, fake_claude_source(calls));
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () =>
      readFileSync(calls, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as FakeClaudeCall),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
