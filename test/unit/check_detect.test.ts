import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkride_detected, resolve_check_runner } from '../../src/check/detect.js';
import { temp_workspace } from '../helpers/harness.js';

describe('resolve_check_runner', () => {
  it('resolves none explicitly', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(resolve_check_runner('none', workspace)).toBe('none');
    } finally {
      cleanup();
    }
  });

  it('auto resolves to none when nothing is detected', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(resolve_check_runner('auto', workspace)).toBe('none');
    } finally {
      cleanup();
    }
  });

  it('auto detects checkride.config.json', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      writeFileSync(join(workspace, 'checkride.config.json'), '{}');
      expect(resolve_check_runner('auto', workspace)).toBe('checkride');
    } finally {
      cleanup();
    }
  });

  it('auto detects a checkride check script', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      writeFileSync(
        join(workspace, 'package.json'),
        JSON.stringify({ scripts: { check: 'checkride' } }),
      );
      expect(resolve_check_runner('auto', workspace)).toBe('checkride');
    } finally {
      cleanup();
    }
  });

  it('does not detect an unrelated check script', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      writeFileSync(
        join(workspace, 'package.json'),
        JSON.stringify({ scripts: { check: 'npm test && checkrider' } }),
      );
      expect(resolve_check_runner('auto', workspace)).toBe('none');
    } finally {
      cleanup();
    }
  });

  it('auto detects node_modules/.bin/checkride', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      mkdirSync(join(workspace, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(workspace, 'node_modules', '.bin', 'checkride'), '#!/bin/sh\n');
      expect(checkride_detected(workspace)).toBe(true);
      expect(resolve_check_runner('auto', workspace)).toBe('checkride');
    } finally {
      cleanup();
    }
  });

  it('treats arbitrary strings as commands', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(resolve_check_runner('npm test', workspace)).toBe('command');
    } finally {
      cleanup();
    }
  });

  it('recognizes a checkride invocation passed as a command', () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      expect(resolve_check_runner('pnpm exec checkride --json', workspace)).toBe('checkride');
      expect(resolve_check_runner('checkride', workspace)).toBe('checkride');
    } finally {
      cleanup();
    }
  });
});
