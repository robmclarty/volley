/**
 * The flow of `./flow.ts` built for drawing, not running. `pnpm diagram` hands
 * this module to fascicle's `fascicle-diagram`, and `test/unit/flow_diagram.test.ts`
 * holds the `flow.ts` header and the README's copy to what it draws. The engine
 * is a stub that is never called, and the config is resolved from placeholders
 * with an empty environment, so drawing needs no credentials, no runtime, and
 * nothing from the caller's shell.
 */
import { make_stub_engine } from 'fascicle/testing';
import type { Step } from 'fascicle';
import { resolve_config } from './config.js';
import { build_flow } from './flow.js';
import type { LoopOutcome } from './flow.js';
import { create_renderer } from './render/renderer.js';
import type { RunInput } from './types.js';

export function flow(): Step<RunInput, LoopOutcome> {
  const config = resolve_config(
    { prompt: 'draw the flow', workspace: '.', criteria: 'none' },
    { env: {} },
  );
  const renderer = create_renderer({
    mode: 'quiet',
    show_thinking: false,
    color: false,
    max_cost_usd: null,
    write: () => {},
  });
  return build_flow(
    { engine: make_stub_engine([]), config, renderer, bash_executor: null, baseline: null },
    null,
  );
}
