import { describe, expect, it } from 'vitest';
import {
  aborted_error,
  claude_cli_error,
  provider_error,
  schema_validation_error,
} from 'fascicle';
import {
  EXIT_BUDGET_EXHAUSTED,
  EXIT_BUILDER_ERROR,
  EXIT_CHECK_ERROR,
  EXIT_CONFIG_ERROR,
  EXIT_COST_CAP,
  EXIT_GATE_EDIT,
  EXIT_CRITIC_ERROR,
  EXIT_INTERRUPTED,
  EXIT_SUCCESS,
  exit_code_for_error,
  exit_code_for_status,
} from '../../src/exit_codes.js';
import { check_error, config_error, phase_error } from '../../src/types.js';

describe('exit_code_for_status', () => {
  it('maps run statuses to exit codes', () => {
    expect(exit_code_for_status('success')).toBe(EXIT_SUCCESS);
    expect(exit_code_for_status('budget_exhausted')).toBe(EXIT_BUDGET_EXHAUSTED);
    expect(exit_code_for_status('cost_cap_reached')).toBe(EXIT_COST_CAP);
    expect(exit_code_for_status('gate_edit_blocked')).toBe(EXIT_GATE_EDIT);
    expect(exit_code_for_status('interrupted')).toBe(EXIT_INTERRUPTED);
  });
});

describe('exit_code_for_error', () => {
  it('config errors -> 5', () => {
    expect(exit_code_for_error(config_error('bad flag'))).toBe(EXIT_CONFIG_ERROR);
  });

  it('check errors -> 4', () => {
    expect(exit_code_for_error(check_error('broken pipeline'))).toBe(EXIT_CHECK_ERROR);
  });

  it('builder provider failures -> 3', () => {
    const cli_err = new claude_cli_error('binary_not_found', 'claude not found');
    expect(exit_code_for_error(phase_error('builder', 1, cli_err))).toBe(EXIT_BUILDER_ERROR);
    expect(exit_code_for_error(new provider_error('boom'))).toBe(EXIT_BUILDER_ERROR);
  });

  it('critic failures -> 6, including schema validation', () => {
    const schema_err = new schema_validation_error('invalid', {}, 'raw');
    expect(exit_code_for_error(phase_error('critic', 2, schema_err))).toBe(EXIT_CRITIC_ERROR);
    expect(exit_code_for_error(schema_err)).toBe(EXIT_CRITIC_ERROR);
  });

  it('aborts -> 130 regardless of the wrapping phase', () => {
    expect(exit_code_for_error(new aborted_error('sigint'))).toBe(EXIT_INTERRUPTED);
    expect(
      exit_code_for_error(phase_error('builder', 1, new aborted_error('sigint'))),
    ).toBe(EXIT_INTERRUPTED);
    expect(
      exit_code_for_error(phase_error('critic', 1, new aborted_error('sigint'))),
    ).toBe(EXIT_INTERRUPTED);
  });

  it('check phase wrapping -> 4', () => {
    expect(exit_code_for_error(phase_error('check', 1, new Error('spawn fail')))).toBe(
      EXIT_CHECK_ERROR,
    );
  });

  it('unknown errors default to 3', () => {
    expect(exit_code_for_error(new Error('mystery'))).toBe(EXIT_BUILDER_ERROR);
    expect(exit_code_for_error('string error')).toBe(EXIT_BUILDER_ERROR);
  });
});
