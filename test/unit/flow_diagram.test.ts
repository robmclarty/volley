import { readFileSync } from 'node:fs';
import { describe as describe_flow } from 'fascicle';
import { describe, expect, it } from 'vitest';
import { flow } from '../../src/diagram.js';

/** The last paragraph of `src/flow.ts`'s header comment, which is the diagram. */
function read_header_diagram(): string {
  const source = readFileSync(new URL('../../src/flow.ts', import.meta.url), 'utf8');
  const header = source.slice(0, source.indexOf('\n */'));
  const lines = header.split('\n');
  return lines.slice(lines.lastIndexOf(' *') + 1).join('\n');
}

const README_MARKER = '<!-- flow diagram: pnpm diagram -->';

/** The fenced block that follows the README's flow-diagram marker. */
function read_readme_diagram(): string {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const at = readme.indexOf(README_MARKER);
  expect(at, `README.md is missing ${README_MARKER}`).toBeGreaterThanOrEqual(0);
  const block = /^\s*```text\n([\s\S]*?)\n```/.exec(readme.slice(at + README_MARKER.length));
  expect(block, `no \`\`\`text block follows ${README_MARKER}`).not.toBeNull();
  return block?.[1] ?? '';
}

describe('flow diagram', () => {
  it('the header diagram in src/flow.ts matches the flow', () => {
    expect(read_header_diagram()).toBe(describe_flow.diagram(flow(), { prefix: ' *   ' }));
  });

  it("the README's diagram matches the flow", () => {
    expect(read_readme_diagram()).toBe(describe_flow.diagram(flow()));
  });
});
