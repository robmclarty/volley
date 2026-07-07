import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECK_ARTIFACT_MAX_CHARS,
  failing_checks,
  parse_checkride_summary,
  read_failing_artifacts,
} from '../../src/check/checkride.js';
import { error_kind } from '../../src/types.js';
import { temp_workspace } from '../helpers/harness.js';

function summary_fixture(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    timestamp: '2026-07-07T00:00:00Z',
    ok: true,
    total_duration_ms: 4200,
    checks: [
      {
        name: 'types',
        adapter: 'tsc',
        description: 'typecheck',
        ok: true,
        exit_code: 0,
        duration_ms: 2000,
        output_file: null,
      },
      {
        name: 'test',
        adapter: 'vitest',
        description: 'tests',
        ok: true,
        exit_code: 0,
        duration_ms: 2200,
        output_file: 'test.json',
      },
    ],
    ...overrides,
  };
}

describe('parse_checkride_summary', () => {
  it('parses a passing summary', () => {
    const { summary, warning } = parse_checkride_summary(JSON.stringify(summary_fixture()));
    expect(summary.ok).toBe(true);
    expect(warning).toBeNull();
    expect(failing_checks(summary)).toHaveLength(0);
  });

  it('identifies failing slots, ignoring skipped ones', () => {
    const fixture = summary_fixture({
      ok: false,
      checks: [
        { name: 'lint', adapter: 'oxlint', ok: false, exit_code: 1, duration_ms: 10, output_file: 'lint.json' },
        { name: 'dead', adapter: null, ok: false, skipped: true, exit_code: null, duration_ms: 0, output_file: null },
        { name: 'test', adapter: 'vitest', ok: false, exit_code: -1, duration_ms: 60000, output_file: 'test.json' },
      ],
    });
    const { summary } = parse_checkride_summary(JSON.stringify(fixture));
    expect(failing_checks(summary).map((c) => c.name)).toEqual(['lint', 'test']);
  });

  it('tolerates unknown extra fields', () => {
    const fixture = { ...summary_fixture(), future_field: { nested: true } };
    const { summary } = parse_checkride_summary(JSON.stringify(fixture));
    expect(summary.checks).toHaveLength(2);
  });

  it('warns on an unexpected schema_version but still parses', () => {
    const { summary, warning } = parse_checkride_summary(
      JSON.stringify(summary_fixture({ schema_version: 2 })),
    );
    expect(summary.ok).toBe(true);
    expect(warning).toMatch(/schema_version 2/);
  });

  it('throws check_error on unparseable stdout', () => {
    try {
      parse_checkride_summary('not json');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(error_kind(err)).toBe('check_error');
    }
  });

  it('throws check_error when checks is missing', () => {
    try {
      parse_checkride_summary('{"ok": true}');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(error_kind(err)).toBe('check_error');
    }
  });
});

describe('read_failing_artifacts', () => {
  it('reads output_file artifacts and falls back to <slot>.stdout.txt', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, '.check'));
      writeFileSync(join(workspace, '.check', 'lint.json'), '{"issues": 3}');
      writeFileSync(join(workspace, '.check', 'test.stdout.txt'), '1 failing');
      const artifacts = read_failing_artifacts(workspace, [
        { name: 'lint', adapter: 'oxlint', ok: false, exit_code: 1, duration_ms: 1, output_file: 'lint.json' },
        { name: 'test', adapter: 'vitest', ok: false, exit_code: 1, duration_ms: 1, output_file: null },
        { name: 'ghost', adapter: null, ok: false, exit_code: 1, duration_ms: 1, output_file: null },
      ]);
      expect(artifacts[0]?.content).toBe('{"issues": 3}');
      expect(artifacts[1]?.content).toBe('1 failing');
      expect(artifacts[2]?.path).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('truncates oversized artifacts with a pointer', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, '.check'));
      writeFileSync(join(workspace, '.check', 'big.json'), 'x'.repeat(CHECK_ARTIFACT_MAX_CHARS + 100));
      const [artifact] = read_failing_artifacts(workspace, [
        { name: 'big', adapter: null, ok: false, exit_code: 1, duration_ms: 1, output_file: 'big.json' },
      ]);
      expect(artifact?.truncated).toBe(true);
      expect(artifact?.content.length).toBe(CHECK_ARTIFACT_MAX_CHARS);
    } finally {
      cleanup();
    }
  });
});
