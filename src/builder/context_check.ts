/**
 * Best-effort local-context guard (D12 / step 10). A too-small context window
 * silently truncates the tool schemas volley sends — the #1 reported local
 * tool-calling failure (Ollama's 4k default). We warn at builder start *where
 * the value is detectable* and never block or fail on it: detection is a
 * courtesy, the setup requirement is the user's (README `## Local builder`).
 */
import type { BuilderProvider } from '../types.js';

/** Below this, tool schemas start getting truncated for volley's tool set. */
export const MIN_RECOMMENDED_NUM_CTX = 16384;

/** Probe timeout — a local `/api/show` answers in single-digit ms when up; a
 * hung server must not stall builder start. */
const PROBE_TIMEOUT_MS = 2000;

/** The warning when a detected context window is too small, or null when the
 * window is adequate or unknown (`num_ctx === null` = not detectable). Pure so
 * the threshold decision is unit-testable without a server. */
export function context_warning(model: string, num_ctx: number | null): string | null {
  if (num_ctx === null || num_ctx >= MIN_RECOMMENDED_NUM_CTX) return null;
  return (
    `local builder model '${model}' is configured with num_ctx ${String(num_ctx)}, below the ` +
    `~${String(MIN_RECOMMENDED_NUM_CTX)} volley recommends: a small context window silently ` +
    'truncates the tool schemas (the #1 local tool-calling failure). Raise it (e.g. a Modelfile ' +
    '`PARAMETER num_ctx 16384`) or expect the model to ignore its tools.'
  );
}

/** Pull `num_ctx` out of Ollama's newline-delimited `parameters` blob
 * (e.g. `"num_ctx                    4096\nstop \"<|im_end|>\""`). Null when
 * the parameter is absent or unparseable — which is the common case for a
 * server relying on its own default, and precisely the "not detectable" edge. */
export function parse_num_ctx(parameters: string | null): number | null {
  if (parameters === null) return null;
  const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Best-effort probe of an Ollama server for a model's configured `num_ctx`
 * via `/api/show` (`base_url` is the server root). Returns null on any
 * failure (server down, non-OK, field absent, parse/JSON error) — the
 * warning never gates the builder. */
export async function probe_ollama_num_ctx(
  base_url: string,
  model: string,
  abort?: AbortSignal,
): Promise<number | null> {
  const signals = [AbortSignal.timeout(PROBE_TIMEOUT_MS)];
  if (abort !== undefined) signals.push(abort);
  try {
    const res = await fetch(`${base_url.replace(/\/$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { parameters?: unknown };
    return parse_num_ctx(typeof body.parameters === 'string' ? body.parameters : null);
  } catch {
    return null;
  }
}

/** Emit a small-context warning via `warn` when an Ollama builder model's
 * `num_ctx` is detectably below the recommended floor. Ollama-only — LM Studio
 * exposes no reliable pre-flight context field, so it is documented, not
 * probed. Never throws (D7 spirit: setup friction is data, not an error). */
export async function warn_small_local_context(
  provider: BuilderProvider,
  model: string,
  base_url: string,
  warn: (message: string) => void,
  abort?: AbortSignal,
): Promise<void> {
  if (provider !== 'ollama') return;
  const warning = context_warning(model, await probe_ollama_num_ctx(base_url, model, abort));
  if (warning !== null) warn(warning);
}
