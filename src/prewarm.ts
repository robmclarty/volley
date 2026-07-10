/**
 * Best-effort Ollama model pre-load. A cold multi-GB model can spend minutes
 * in load + first prompt eval — longer than the provider path's in-request
 * header timeout — so the first real `generate` dies with an opaque
 * `stream interrupted: fetch failed`. Ollama's documented load call (a
 * `/api/generate` POST with a model and no prompt) returns as soon as the
 * model is resident, so absorbing the load here keeps the real call's
 * time-to-first-byte inside its budget.
 *
 * Best-effort like the context probe: any failure (server down, unknown
 * model, timeout) is swallowed — the real generate call surfaces the error
 * with retry and reporting behind it. Ollama-only; LM Studio has no
 * equivalent load-without-generating endpoint.
 */

/** Generous ceiling on the load itself: a disk-cold 30B-class model takes
 * tens of seconds to minutes. Past this, give up and let the real call try. */
export const PREWARM_TIMEOUT_MS = 300_000;

/** Load `model` into the Ollama server's memory (`base_url` is the server
 * root). Resolves when the model is resident, on any failure, or at the
 * timeout — never throws, never gates the phase. An already-resident model
 * returns immediately, so warming the same model for both roles is free. */
export async function prewarm_ollama_model(
  base_url: string,
  model: string,
  abort?: AbortSignal,
): Promise<void> {
  const signals = [AbortSignal.timeout(PREWARM_TIMEOUT_MS)];
  if (abort !== undefined) signals.push(abort);
  try {
    await fetch(`${base_url.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.any(signals),
    });
  } catch {
    // Best-effort: the real generate call owns error surfacing.
  }
}
