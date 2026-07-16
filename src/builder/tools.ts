/**
 * Builder tool set for local (non-CLI) builders (v3 s1, D2).
 *
 * A local model brings no built-in tools, so volley supplies the whole
 * agentic surface: the shared read-only trio (reused from
 * `src/workspace_tools.ts`, C4) plus `write_file`, `edit_file`, `bash`,
 * `fetch`, and the terminal `finish`. File paths are confined to the
 * workspace via `contain()`.
 *
 * Error semantics (D4/D10): a wrong-but-recoverable input — `edit_file`
 * matching 0 or N places, a `bash` command exiting non-zero or timing out, a
 * `fetch` that is SSRF-blocked or fails — is *returned* as a tool result the
 * model reads and acts on. Tools throw only on a genuine harness fault
 * (containment violation, unreadable input, over-cap write).
 *
 * `fetch` (D9) is a native readability pipeline (`linkedom` + `@mozilla/
 * readability` + `turndown`) with SSRF protection at the undici connector, not
 * as a pre-flight URL check: a validating DNS `lookup` rejects hostnames that
 * resolve to a non-unicast address before the TCP connect, and the resolved
 * socket's peer address is re-checked after connect — which also catches
 * literal-IP URLs (Node skips `lookup` for those) and every redirect hop
 * (each re-dispatches through the same guarded connector). The byte cap is
 * enforced while reading the HTTP stream, so raw HTML is never returned and a
 * huge page cannot OOM the tool (C7).
 *
 * Egress is defended in two independent layers (s2 D6/D12): this tool's SSRF
 * deny-list (above) and the sandbox's container network posture (`--network none`
 * by default, or a host-collapsed allowlist bridge — see `SandboxNetwork` in
 * `src/sandbox.ts`). Under whole-process containment (B′/D5) the whole volley
 * process — `fetch` included — runs inside the container, so both layers apply to
 * `fetch`'s egress: `--network none` leaves it no route and it returns a "could
 * not fetch" error result, and the loop continues.
 */
import { spawnSync } from 'node:child_process';
import { lookup as dns_lookup } from 'node:dns';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { LookupFunction } from 'node:net';
import { dirname } from 'node:path';
import { Readability } from '@mozilla/readability';
import ipaddr from 'ipaddr.js';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { Agent, buildConnector, interceptors, request } from 'undici';
import { z } from 'zod';
import type { Tool, ToolExecContext } from 'fascicle';
import { contain, read_only_tools } from '../workspace_tools.js';

export const WRITE_FILE_MAX_BYTES = 1_000_000;

// Sized to fit a workspace `pnpm check`: volley's own checkride timeout is
// 600s (Q1), so a shorter budget would kill the builder's self-verify
// mid-run. Overridable per call site via `BuilderToolOptions` (tests use a
// short value so the timeout path is exercised without a 10-minute wait).
export const BASH_TIMEOUT_MS = 600_000;

// Model-facing cap on each of stdout/stderr; oversize output is truncated
// with a marker (D3 failure mode). Not a memory guard — `BASH_CAPTURE_MAX_BYTES`
// below bounds what `spawnSync` buffers before we ever truncate.
export const BASH_MAX_OUTPUT_BYTES = 100_000;

// OOM backstop on `spawnSync`'s captured output, well above the display cap:
// a command that floods gigabytes is bounded here, then truncated to the
// display cap for the model.
const BASH_CAPTURE_MAX_BYTES = 10_000_000;

// Hard cap on bytes read from the HTTP stream before conversion (C7): a page
// larger than this is truncated at the socket, so raw HTML never reaches the
// model and a huge page cannot OOM the tool.
export const FETCH_MAX_BYTES = 200_000;

// Default page-size for the model-facing markdown slice; `start_index`
// paginates through the rest (MCP fetch-server contract, D9).
export const FETCH_MAX_CHARS = 5000;

// How many redirect hops to follow. Each hop re-dispatches through the same
// SSRF-guarded connector, so a redirect into a private range is still refused.
const FETCH_MAX_REDIRECTS = 5;

// Per-request timeout (headers and body idle), in ms.
const FETCH_TIMEOUT_MS = 30_000;

// Below this, readability's extraction is treated as a miss (empty article /
// JS-rendered SPA) and we fall back to converting the whole document body.
const FETCH_MIN_EXTRACT_CHARS = 200;

const FETCH_USER_AGENT = 'volley-local-builder';

/** The raw outcome of running one bash command, before the model-facing
 * truncation + timeout marker the `bash` tool applies. `status` is the exit code
 * (null when the process was killed by a signal — e.g. the timeout SIGKILL);
 * `timed_out` marks the timeout path. */
export type BashOutcome = {
  status: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
};

/** How the `bash` tool runs a command: the local `host_bash_executor`
 * (`spawnSync`) — which under whole-process containment (B′/D5) runs *inside*
 * volley's own hardened container, no `docker exec` hop. The executor runs one
 * command to completion and returns its raw outcome; the `bash` tool owns the
 * truncation + timeout marker. Kept as an injectable seam so tests can supply a
 * fake and a future shape could re-point it (the `docker exec` executor was
 * retired in step 13). */
export type BashExecutor = (
  command: string,
  options: { timeout_ms: number; max_capture_bytes: number },
) => BashOutcome;

export type BuilderToolOptions = {
  /** Override `BASH_TIMEOUT_MS` (ms). */
  bash_timeout_ms?: number;
  /** Override `BASH_MAX_OUTPUT_BYTES` (bytes, per stream). */
  bash_max_output_bytes?: number;
  /**
   * Where `bash` runs a command. Defaults to `host_bash_executor` — the local
   * `spawnSync`, which under B′ runs inside volley's own container against the
   * bind-mounted worktree. Injectable so tests can supply a fake (the
   * `docker exec` executor was retired in step 13).
   */
  bash_executor?: BashExecutor;
  /** Override `FETCH_MAX_BYTES` (bytes read from the HTTP stream before the cap). */
  fetch_max_bytes?: number;
  /**
   * Test seam: override the connection-time SSRF classifier. Production leaves
   * this unset and uses `is_forbidden_address`, which rejects every non-unicast
   * (private / loopback / link-local / CGNAT / …) address. Tests set it to reach
   * a loopback fixture server while still exercising the real rejection path.
   */
  fetch_is_address_forbidden?: (address: string) => boolean;
  /**
   * Test seam: override the DNS resolver the SSRF connector validates through.
   * Defaults to `node:dns` `lookup`. Lets a test point a hostname at a private
   * address to exercise the redirect-into-private-range rejection.
   */
  fetch_lookup?: LookupFunction;
};

const write_file_input = z.object({
  path: z.string().describe('Workspace-relative path to write. Parent directories are created.'),
  content: z.string().describe('Full UTF-8 content of the file. Overwrites any existing content.'),
});

const edit_file_input = z.object({
  path: z.string().describe('Workspace-relative path of the file to edit.'),
  old_str: z
    .string()
    .min(1)
    .describe('Exact text to replace. Must occur exactly once in the file.'),
  new_str: z.string().describe('Replacement text.'),
});

const bash_input = z.object({
  command: z.string().describe('Shell command to run in the workspace directory.'),
});

const finish_input = z.object({
  summary: z.string().describe('Short summary of what was accomplished.'),
});

const fetch_input = z.object({
  url: z.string().describe('Absolute http(s) URL to fetch.'),
  max_chars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum characters of extracted markdown to return (default ${String(FETCH_MAX_CHARS)}).`),
  start_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Character offset into the extracted markdown to start from, for paging a long page. Default 0.'),
});

function count_occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Truncate `text` to at most `max` bytes, appending a marker when clipped.
 * Byte-based to honor the byte cap; a split multibyte char at the boundary
 * renders as the replacement char, which is acceptable for tool output. */
function truncate_bytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const clipped = Buffer.from(text, 'utf8').subarray(0, max).toString('utf8');
  return `${clipped}\n… [truncated at ${String(max)} bytes]`;
}

/**
 * Non-unicast → forbidden (D9/C7). Rejects loopback, private, link-local,
 * unspecified, broadcast, multicast, CGNAT, and the IPv6 equivalents; an
 * IPv4-mapped IPv6 address is folded to its v4 form first so `::ffff:127.0.0.1`
 * is caught as loopback (and `::ffff:<public>` is still allowed). An
 * unparseable address fails closed.
 */
export function is_forbidden_address(address: string): boolean {
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return true;
  }
  const canonical =
    'isIPv4MappedAddress' in parsed && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed;
  return canonical.range() !== 'unicast';
}

// Default DNS resolver the SSRF connector validates through; the `fetch_lookup`
// option swaps it in tests.
const default_resolver: LookupFunction = (hostname, options, callback) => {
  dns_lookup(hostname, options, callback);
};

// A `lookup` that resolves normally, then rejects the connection if any
// resolved address is forbidden — closing the DNS-rebinding / redirect-hop gap
// a pre-flight URL check leaves open (D9). Runs before the TCP connect, so a
// hostname pointing at a private range never opens a socket.
function guarded_lookup(is_forbidden: (address: string) => boolean, resolve: LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, options, (err, address, family) => {
      if (err !== null) {
        callback(err, '', 0);
        return;
      }
      const resolved = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
      const blocked = resolved.find((entry) => is_forbidden(entry));
      if (blocked !== undefined) {
        callback(ssrf_error(blocked, hostname), '', 0);
        return;
      }
      callback(null, address, family);
    });
  };
}

function ssrf_error(address: string, hostname: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `blocked non-unicast address ${address} for host "${hostname}"`,
  );
  err.code = 'ERR_SSRF_BLOCKED';
  return err;
}

// An undici Agent whose connector validates SSRF at two points: the `lookup`
// above (hostnames, before connect) and the peer address of the established
// socket (which also catches literal-IP URLs — Node skips `lookup` for those —
// and every redirect hop, since each re-dispatches through this connector).
function create_ssrf_agent(is_forbidden: (address: string) => boolean, resolve: LookupFunction): Agent {
  const base = buildConnector({ lookup: guarded_lookup(is_forbidden, resolve), timeout: FETCH_TIMEOUT_MS });
  const connector: typeof base = (options, callback) => {
    base(options, (err, socket) => {
      if (err !== null) {
        callback(err, null);
        return;
      }
      if (socket === null) {
        callback(new Error('connection produced no socket'), null);
        return;
      }
      const remote = socket.remoteAddress;
      if (remote !== undefined && is_forbidden(remote)) {
        socket.destroy();
        callback(ssrf_error(remote, options.hostname), null);
        return;
      }
      callback(null, socket);
    });
  };
  return new Agent({ connect: connector, headersTimeout: FETCH_TIMEOUT_MS, bodyTimeout: FETCH_TIMEOUT_MS });
}

// Read the response body, stopping at `max_bytes` so raw HTML never fully
// buffers (C7). Breaking the `for await` destroys the stream, ending the
// download.
async function read_body_capped(body: AsyncIterable<Buffer>, max_bytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = max_bytes - total;
    if (buf.length >= remaining) {
      chunks.push(buf.subarray(0, remaining));
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return Buffer.concat(chunks);
}

function header_value(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function content_kind(content_type: string, body: string): 'html' | 'text' | 'binary' {
  const ct = content_type.toLowerCase();
  if (ct.includes('html') || ct.includes('xml')) return 'html';
  if (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('javascript') ||
    ct.includes('csv')
  ) {
    return 'text';
  }
  if (ct === '') return body.trimStart().startsWith('<') ? 'html' : 'text';
  return 'binary';
}

// Extract the main content as markdown: readability over a linkedom DOM, then
// turndown. Falls back to converting the whole document when readability finds
// little (empty article / JS-rendered SPA). Never returns raw HTML.
function extract_markdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  turndown.remove(['script', 'style', 'noscript']);
  let body_markdown = '';
  let title = '';
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    if (article !== null) {
      title = (article.title ?? '').trim();
      if (article.content) {
        body_markdown = turndown.turndown(article.content).trim();
      }
    }
  } catch {
    body_markdown = '';
  }
  if (body_markdown.length < FETCH_MIN_EXTRACT_CHARS) {
    let fallback = '';
    try {
      fallback = turndown.turndown(html).trim();
    } catch {
      fallback = '';
    }
    if (fallback.length > body_markdown.length) body_markdown = fallback;
  }
  const prefix = title.length > 0 && !body_markdown.startsWith(`# ${title}`) ? `# ${title}\n\n` : '';
  return `${prefix}${body_markdown}`.trim();
}

// MCP fetch-server pagination: return the `max_chars` slice at `start_index`,
// and when more remains, a self-describing trailer naming the next start_index.
function paginate(full: string, max_chars: number, start_index: number): string {
  if (start_index >= full.length) {
    return `(no more content: start_index ${String(start_index)} is at or past the end of the ${String(full.length)}-character document)`;
  }
  const slice = full.slice(start_index, start_index + max_chars);
  const next = start_index + slice.length;
  if (next >= full.length) return slice;
  const remaining = full.length - next;
  return `${slice}\n\n<truncated: ${String(remaining)} more characters. Call fetch again with start_index=${String(next)} to continue.>`;
}

// Flatten an error (and its `cause` chain) into a single line for the model.
function error_detail(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      parts.push(code !== undefined ? `${current.message} [${code}]` : current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      // Thrown values are Errors in practice; a non-Error is defensive only, so
      // keep a string as-is and never risk an "[object Object]" stringification.
      parts.push(typeof current === 'string' ? current : `non-error value (${typeof current})`);
      break;
    }
  }
  return parts.length > 0 ? parts.join(' <- ') : 'unknown error';
}

type FetchConfig = {
  is_forbidden: (address: string) => boolean;
  resolve: LookupFunction;
  max_bytes: number;
};

async function run_fetch(raw: unknown, ctx: ToolExecContext, config: FetchConfig): Promise<string> {
  const input = fetch_input.parse(raw);
  const max_chars = input.max_chars ?? FETCH_MAX_CHARS;
  const start_index = input.start_index ?? 0;

  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return `error: not a valid absolute URL: ${input.url}`;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return `error: unsupported URL scheme "${target.protocol}" — only http and https are fetched`;
  }

  const agent = create_ssrf_agent(config.is_forbidden, config.resolve);
  const dispatcher = agent.compose(interceptors.redirect({ maxRedirections: FETCH_MAX_REDIRECTS }));
  try {
    const res = await request(target.href, {
      dispatcher,
      signal: ctx.abort,
      headersTimeout: FETCH_TIMEOUT_MS,
      bodyTimeout: FETCH_TIMEOUT_MS,
      headers: {
        'user-agent': FETCH_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        // No compression: keep the pipeline simple and the byte cap honest.
        'accept-encoding': 'identity',
      },
    });
    if (res.statusCode >= 400) {
      await res.body.dump();
      return `error: HTTP ${String(res.statusCode)} fetching ${target.href}`;
    }
    const bytes = await read_body_capped(res.body, config.max_bytes);
    const content_type = header_value(res.headers['content-type']);
    const text = bytes.toString('utf8');
    if (text.trim().length === 0) {
      return `error: empty response body from ${target.href}`;
    }
    const kind = content_kind(content_type, text);
    if (kind === 'binary') {
      return `error: cannot extract non-text content (content-type: ${content_type}) from ${target.href}`;
    }
    const markdown = kind === 'html' ? extract_markdown(text) : text.trim();
    if (markdown.length === 0) {
      return `error: no readable content extracted from ${target.href}`;
    }
    return paginate(markdown, max_chars, start_index);
  } catch (err) {
    return `error: could not fetch ${target.href}: ${error_detail(err)}`;
  } finally {
    await agent.close().catch(() => undefined);
  }
}

/**
 * The `bash` executor: run the command via `spawnSync` with a shell, bounded by
 * the timeout (SIGKILL on expiry) and the OOM capture cap. Under whole-process
 * containment (B′/D5) this runs *inside* volley's hardened container against the
 * bind-mounted worktree — the container is the isolation boundary, no
 * `docker exec` hop — and it is likewise the executor on the
 * `--allow-unsandboxed-builder` host escape hatch (shape C). `status` is null
 * when a signal (the timeout SIGKILL) killed the process.
 */
export function host_bash_executor(cwd: string): BashExecutor {
  return (command, options) => {
    const result = spawnSync(command, {
      shell: true,
      cwd,
      encoding: 'utf8',
      timeout: options.timeout_ms,
      killSignal: 'SIGKILL',
      maxBuffer: options.max_capture_bytes,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timed_out: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    };
  };
}

// Same wiring convention as the shared read tools: each tool is typed as
// fascicle's `Tool` (input `unknown`) and re-parses the model's raw
// arguments with its own schema inside `execute`.
export function builder_tools(workspace: string, options: BuilderToolOptions = {}): Tool[] {
  const bash_timeout_ms = options.bash_timeout_ms ?? BASH_TIMEOUT_MS;
  const bash_max_output_bytes = options.bash_max_output_bytes ?? BASH_MAX_OUTPUT_BYTES;
  const bash_executor = options.bash_executor ?? host_bash_executor(workspace);

  const write_file: Tool = {
    name: 'write_file',
    description:
      'Write a UTF-8 text file in the workspace, creating parent directories ' +
      'and overwriting any existing content. Rejects content over ' +
      `${String(WRITE_FILE_MAX_BYTES)} bytes.`,
    input_schema: write_file_input,
    execute: (raw) => {
      const input = write_file_input.parse(raw);
      const abs = contain(workspace, input.path);
      const bytes = Buffer.byteLength(input.content, 'utf8');
      if (bytes > WRITE_FILE_MAX_BYTES) {
        throw new Error(
          `content is ${String(bytes)} bytes, over the ${String(WRITE_FILE_MAX_BYTES)}-byte write cap`,
        );
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, input.content, 'utf8');
      return `wrote ${String(bytes)} bytes to ${input.path}`;
    },
  };

  const edit_file: Tool = {
    name: 'edit_file',
    description:
      'Replace one exact occurrence of old_str with new_str in a workspace ' +
      'file. old_str must match the file content exactly once — on 0 or ' +
      'multiple matches nothing is changed and an error is returned; read ' +
      'the file and retry with a longer, unique old_str.',
    input_schema: edit_file_input,
    execute: (raw) => {
      const input = edit_file_input.parse(raw);
      const abs = contain(workspace, input.path);
      const content = readFileSync(abs, 'utf8');
      const matches = count_occurrences(content, input.old_str);
      if (matches === 0) {
        return (
          `error: old_str not found in ${input.path} (0 matches). ` +
          'No change made. Read the file and retry with an exact excerpt of its current content.'
        );
      }
      if (matches > 1) {
        return (
          `error: old_str matches ${String(matches)} times in ${input.path}. ` +
          'No change made. Include more surrounding context to make old_str unique.'
        );
      }
      writeFileSync(abs, content.replace(input.old_str, input.new_str), 'utf8');
      return `edit applied to ${input.path}`;
    },
  };

  const bash: Tool = {
    name: 'bash',
    description:
      'Run a shell command in the workspace and return its exit code, stdout, ' +
      'and stderr. Each call is independent — no shell state (working ' +
      'directory, environment, variables) carries over between commands. A ' +
      'non-zero exit is a normal result, not an error: read it and adjust. ' +
      `Each stream is truncated past ${String(bash_max_output_bytes)} bytes, ` +
      `and the command is killed if it runs longer than ${String(bash_timeout_ms)}ms.`,
    input_schema: bash_input,
    // D3/D4: stateless per command (the executor is injectable without touching
    // this contract — under B′ it is the local `spawnSync` running in-container),
    // and never throws on the command's own failure — a non-zero exit or a
    // timeout is *returned* as `{ exit_code, stdout, stderr }` for the model to
    // read. The executor buffers up to `BASH_CAPTURE_MAX_BYTES` (OOM guard)
    // before we truncate to the model-facing cap.
    execute: (raw) => {
      const input = bash_input.parse(raw);
      const outcome = bash_executor(input.command, {
        timeout_ms: bash_timeout_ms,
        max_capture_bytes: BASH_CAPTURE_MAX_BYTES,
      });
      let stderr = truncate_bytes(outcome.stderr, bash_max_output_bytes);
      if (outcome.timed_out) {
        const note = `[command timed out after ${String(bash_timeout_ms)}ms and was killed]`;
        stderr = stderr.length > 0 ? `${stderr}\n${note}` : note;
      }
      // `status` is the numeric exit code, or null when the process was killed
      // by a signal (e.g. the timeout SIGKILL).
      return {
        exit_code: outcome.status,
        stdout: truncate_bytes(outcome.stdout, bash_max_output_bytes),
        stderr,
      };
    },
  };

  const fetch: Tool = {
    name: 'fetch',
    description:
      'Fetch an http(s) URL and return its main content converted to Markdown. ' +
      `Returns at most max_chars characters (default ${String(FETCH_MAX_CHARS)}); ` +
      'when the page is longer, a trailer names the start_index to pass to read ' +
      'the next slice. Private, loopback, and link-local addresses are refused. ' +
      'A blocked, non-HTML, or failed request returns an error string you can read and act on.',
    input_schema: fetch_input,
    // D9: native readability pipeline with connection-time SSRF protection; a
    // blocked / non-HTML / HTTP error is returned as a tool result (D4), not
    // thrown. The classifier and resolver are overridable for tests only.
    execute: (raw, ctx) =>
      run_fetch(raw, ctx, {
        is_forbidden: options.fetch_is_address_forbidden ?? is_forbidden_address,
        resolve: options.fetch_lookup ?? default_resolver,
        max_bytes: options.fetch_max_bytes ?? FETCH_MAX_BYTES,
      }),
  };

  const finish: Tool = {
    name: 'finish',
    description:
      'Declare the task complete. Calling this tool ends your turn — do not ' +
      'call it until the work is done and verified.',
    input_schema: finish_input,
    // D6: a successful `finish` ends the loop deterministically. The summary
    // is recorded in the trajectory like any tool call and otherwise ignored
    // — the workspace, not the self-report, is truth.
    ends_turn: true,
    execute: (raw) => {
      const input = finish_input.parse(raw);
      return `finished: ${input.summary}`;
    },
  };

  return [...read_only_tools(workspace), write_file, edit_file, bash, fetch, finish];
}
