import { lookup as dns_lookup } from 'node:dns';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tool } from 'fascicle';
import {
  type BuilderToolOptions,
  WRITE_FILE_MAX_BYTES,
  builder_tools,
  is_forbidden_address,
} from '../../src/builder/tools.js';
import { temp_workspace } from '../helpers/harness.js';

const ctx = {
  abort: new AbortController().signal,
  tool_call_id: 't',
  step_index: 0,
} as const;

function tool_map(workspace: string): Record<string, Tool> {
  return Object.fromEntries(builder_tools(workspace).map((t) => [t.name, t]));
}

async function call(tool: Tool, input: unknown): Promise<string> {
  return (await tool.execute(input, ctx)) as string;
}

type BashResult = { exit_code: number | null; stdout: string; stderr: string };

async function call_bash(tool: Tool, command: string): Promise<BashResult> {
  return (await tool.execute({ command }, ctx)) as BashResult;
}

describe('builder_tools', () => {
  it('exposes the read trio plus write_file, edit_file, bash, fetch, and finish', () => {
    expect(builder_tools('/ws').map((t) => t.name)).toEqual([
      'read_file',
      'search_files',
      'list_files',
      'write_file',
      'edit_file',
      'bash',
      'fetch',
      'finish',
    ]);
  });
});

describe('write_file', () => {
  it('writes a file, creating parent directories, and overwrites', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      const out = await call(tools.write_file!, { path: 'deep/nested/a.ts', content: 'one' });
      expect(out).toContain('deep/nested/a.ts');
      expect(readFileSync(join(workspace, 'deep', 'nested', 'a.ts'), 'utf8')).toBe('one');

      await call(tools.write_file!, { path: 'deep/nested/a.ts', content: 'two' });
      expect(readFileSync(join(workspace, 'deep', 'nested', 'a.ts'), 'utf8')).toBe('two');
    } finally {
      cleanup();
    }
  });

  it('throws on content over the write cap', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await expect(
        call(tools.write_file!, { path: 'big.txt', content: 'z'.repeat(WRITE_FILE_MAX_BYTES + 1) }),
      ).rejects.toThrow(/write cap/);
    } finally {
      cleanup();
    }
  });

  it('refuses to write outside the workspace', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await expect(call(tools.write_file!, { path: '../evil.txt', content: 'x' })).rejects.toThrow(
        /escapes the workspace/,
      );
    } finally {
      cleanup();
    }
  });
});

describe('edit_file', () => {
  function seed(workspace: string): void {
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    writeFileSync(join(workspace, 'src', 'dup.ts'), 'same\nsame\nsame\n');
  }

  it('replaces a unique exact match', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      const out = await call(tools.edit_file!, {
        path: 'src/a.ts',
        old_str: 'const b = 2;',
        new_str: 'const b = 20;',
      });
      expect(out).toContain('edit applied');
      expect(readFileSync(join(workspace, 'src', 'a.ts'), 'utf8')).toBe(
        'const a = 1;\nconst b = 20;\nconst c = 3;\n',
      );
    } finally {
      cleanup();
    }
  });

  it('returns (not throws) an error on 0 matches and changes nothing', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      const out = await call(tools.edit_file!, {
        path: 'src/a.ts',
        old_str: 'const z = 9;',
        new_str: 'const z = 10;',
      });
      expect(out).toContain('0 matches');
      expect(out).toContain('No change made');
      expect(readFileSync(join(workspace, 'src', 'a.ts'), 'utf8')).toContain('const b = 2;');
    } finally {
      cleanup();
    }
  });

  it('returns (not throws) an error on multiple matches and changes nothing', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      seed(workspace);
      const tools = tool_map(workspace);
      const out = await call(tools.edit_file!, {
        path: 'src/dup.ts',
        old_str: 'same',
        new_str: 'different',
      });
      expect(out).toContain('matches 3 times');
      expect(out).toContain('No change made');
      expect(readFileSync(join(workspace, 'src', 'dup.ts'), 'utf8')).toBe('same\nsame\nsame\n');
    } finally {
      cleanup();
    }
  });

  it('refuses to edit outside the workspace', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await expect(
        call(tools.edit_file!, { path: '../../etc/hosts', old_str: 'a', new_str: 'b' }),
      ).rejects.toThrow(/escapes the workspace/);
    } finally {
      cleanup();
    }
  });
});

describe('bash', () => {
  it('returns stdout and exit_code 0 for a zero-exit command', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      const out = await call_bash(tools.bash!, 'echo hello');
      expect(out.exit_code).toBe(0);
      expect(out.stdout).toContain('hello');
      expect(out.stderr).toBe('');
    } finally {
      cleanup();
    }
  });

  it('runs in the workspace directory (stateless per command)', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      await call(tools.write_file!, { path: 'marker.txt', content: 'in-workspace' });
      const out = await call_bash(tools.bash!, 'cat marker.txt');
      expect(out.exit_code).toBe(0);
      expect(out.stdout).toContain('in-workspace');
    } finally {
      cleanup();
    }
  });

  it('returns (not throws) a non-zero exit with stdout and stderr', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = tool_map(workspace);
      const out = await call_bash(tools.bash!, 'echo out; echo err >&2; exit 7');
      expect(out.exit_code).toBe(7);
      expect(out.stdout).toContain('out');
      expect(out.stderr).toContain('err');
    } finally {
      cleanup();
    }
  });

  it('truncates output past the byte cap with a marker', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = builder_tools(workspace, { bash_max_output_bytes: 20 });
      const bash = tools.find((t) => t.name === 'bash')!;
      const out = await call_bash(bash, 'printf "%s" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
      expect(out.exit_code).toBe(0);
      expect(out.stdout).toContain('[truncated at 20 bytes]');
      // 20 kept bytes + a newline + the marker line
      expect(out.stdout.startsWith('aaaaaaaaaaaaaaaaaaaa\n…')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('returns a timed-out command as a normal result, not an error', async () => {
    const { workspace, cleanup } = temp_workspace();
    try {
      const tools = builder_tools(workspace, { bash_timeout_ms: 100 });
      const bash = tools.find((t) => t.name === 'bash')!;
      const out = await call_bash(bash, 'sleep 5');
      expect(out.exit_code).toBeNull();
      expect(out.stderr).toContain('timed out');
    } finally {
      cleanup();
    }
  });
});

describe('finish', () => {
  it('is declared terminal (ends_turn) and returns cleanly', async () => {
    const tools = tool_map('/ws');
    expect(tools.finish!.ends_turn).toBe(true);
    expect(await call(tools.finish!, { summary: 'wrote the thing' })).toContain('wrote the thing');
  });
});

// ---------------------------------------------------------------------------
// fetch — native readability pipeline + connector-level SSRF (D9)
// ---------------------------------------------------------------------------

type TestServer = { origin: string; requests: string[]; close: () => Promise<void> };

const open_servers: TestServer[] = [];

async function start_server(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const test_server: TestServer = {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
  open_servers.push(test_server);
  return test_server;
}

afterEach(async () => {
  await Promise.all(open_servers.splice(0).map((server) => server.close()));
});

// Reach a loopback fixture server while still running the real classifier for
// every other address — so the redirect-into-private path is genuinely tested,
// not stubbed away.
const allow_loopback = (address: string): boolean =>
  address === '127.0.0.1' || address === '::1' ? false : is_forbidden_address(address);

function fetch_tool(workspace: string, overrides: BuilderToolOptions = {}): Tool {
  return builder_tools(workspace, overrides).find((t) => t.name === 'fetch')!;
}

async function call_fetch(tool: Tool, input: unknown): Promise<string> {
  return (await tool.execute(input, ctx)) as string;
}

function article_html(word: string): string {
  const paras = Array.from(
    { length: 40 },
    (_, i) =>
      `<p>${word} paragraph number ${String(i)} with plenty of words so that ` +
      'Readability is confident this is genuine article content worth extracting ' +
      'from the surrounding page chrome.</p>',
  ).join('\n');
  return (
    `<!doctype html><html><head><title>${word}</title></head><body>` +
    '<nav>site navigation menu home about contact</nav>' +
    `<article><h1>${word}</h1>${paras}</article>` +
    '<footer>site footer boilerplate</footer></body></html>'
  );
}

describe('is_forbidden_address', () => {
  it('rejects non-unicast addresses (incl. IPv4-mapped) and allows public ones', () => {
    for (const bad of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.1.1',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
      'not-an-ip',
    ]) {
      expect(is_forbidden_address(bad)).toBe(true);
    }
    for (const ok of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:93.184.216.34']) {
      expect(is_forbidden_address(ok)).toBe(false);
    }
  });
});

describe('fetch', () => {
  it('rejects a literal loopback URL at the socket, as an error result (not thrown)', async () => {
    const server = await start_server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><p>internal secret page</p></body></html>');
    });
    // Default (production) classifier: 127.0.0.1 is a literal IP, so Node skips
    // the lookup guard and the resolved-socket check is what refuses it.
    const out = await call_fetch(fetch_tool('/ws'), { url: `${server.origin}/` });
    expect(out).toMatch(/^error/);
    expect(out).toMatch(/127\.0\.0\.1|blocked|non-unicast/i);
    expect(out).not.toContain('internal secret page');
    expect(server.requests).toEqual([]);
  });

  it('rejects a localhost hostname before connecting (lookup guard)', async () => {
    const out = await call_fetch(fetch_tool('/ws'), { url: 'http://localhost:9/' });
    expect(out).toMatch(/^error/);
    expect(out).toMatch(/blocked|non-unicast|127\.0\.0\.1|::1/i);
  });

  it('rejects a redirect into a private range at connection time', async () => {
    const server = await start_server((_req, res) => {
      res.writeHead(302, { location: 'http://internal.invalid/secret' });
      res.end();
    });
    // internal.invalid resolves to a private address; the redirect hop must be
    // re-resolved and refused through the same guarded connector.
    const fake_lookup: LookupFunction = (hostname, options, callback) => {
      if (hostname === 'internal.invalid') {
        if (options.all === true) callback(null, [{ address: '10.0.0.1', family: 4 }], 4);
        else callback(null, '10.0.0.1', 4);
        return;
      }
      dns_lookup(hostname, options, callback);
    };
    const out = await call_fetch(
      fetch_tool('/ws', { fetch_is_address_forbidden: allow_loopback, fetch_lookup: fake_lookup }),
      { url: `${server.origin}/start` },
    );
    expect(out).toMatch(/^error/);
    expect(out).toMatch(/10\.0\.0\.1|blocked|non-unicast|internal\.invalid/i);
    expect(out).not.toContain('secret page');
  });

  it('extracts HTML to markdown and paginates with a start_index trailer', async () => {
    const server = await start_server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(article_html('Alphabeta'));
    });
    const tool = fetch_tool('/ws', { fetch_is_address_forbidden: allow_loopback });
    const first = await call_fetch(tool, { url: `${server.origin}/post`, max_chars: 200 });
    expect(first).toContain('Alphabeta');
    expect(first).not.toContain('site navigation menu');
    expect(first).not.toContain('<p>');
    expect(first).not.toContain('<nav>');
    const match = first.match(/start_index=(\d+)/);
    expect(match).not.toBeNull();
    const next = Number(match?.[1] ?? '0');
    expect(next).toBeGreaterThan(0);
    const second = await call_fetch(tool, {
      url: `${server.origin}/post`,
      max_chars: 200,
      start_index: next,
    });
    expect(second.length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });

  it('returns plain-text content directly', async () => {
    const server = await start_server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('just some plain text, not html');
    });
    const out = await call_fetch(fetch_tool('/ws', { fetch_is_address_forbidden: allow_loopback }), {
      url: `${server.origin}/notes.txt`,
    });
    expect(out).toContain('just some plain text');
  });

  it('handles an empty response body', async () => {
    const server = await start_server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('');
    });
    const out = await call_fetch(fetch_tool('/ws', { fetch_is_address_forbidden: allow_loopback }), {
      url: `${server.origin}/`,
    });
    expect(out).toMatch(/empty/i);
  });

  it('handles non-text (binary) content without returning it', async () => {
    const server = await start_server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([0, 1, 2, 3, 4]));
    });
    const out = await call_fetch(fetch_tool('/ws', { fetch_is_address_forbidden: allow_loopback }), {
      url: `${server.origin}/blob.bin`,
    });
    expect(out).toMatch(/^error/);
    expect(out).toMatch(/content-type|non-text|octet-stream/i);
  });

  it('enforces fetch_max_bytes at the stream and never returns raw HTML', async () => {
    const sentinel = 'SENTINELPASTCAP';
    const head =
      '<!doctype html><html><head><title>Big</title></head><body><article>' +
      '<p>Alphabeta content near the very start of the page.</p>'.repeat(4);
    const body = `${head}${'x'.repeat(5000)}<p>${sentinel}</p></article></body></html>`;
    const server = await start_server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    });
    const tool = fetch_tool('/ws', {
      fetch_is_address_forbidden: allow_loopback,
      fetch_max_bytes: 500,
    });
    const out = await call_fetch(tool, { url: `${server.origin}/big`, max_chars: 100_000 });
    expect(out).not.toContain(sentinel);
    expect(out).not.toContain('</p>');
    expect(out.length).toBeGreaterThan(0);
  });
});
