# Upstream Ollama report — qwen tool-call parse failure kills the stream

*Draft for the [ollama/ollama](https://github.com/ollama/ollama) tracker.
Distilled from `research/v3-comparison-finding.md` (§ "Model vs transport",
follow-ups). Filing is a human action — everything below the line is the issue
body, ready to paste. The ask is narrow: on a tool-call parse failure, **degrade
to plain text** instead of erroring the stream, so client-side salvage layers
can recover.*

---

**Title:** qwen3.5/qwen3-coder tool-call parser aborts the stream on malformed
markup instead of degrading to plain text

### Summary

When a qwen model emits malformed tool-call markup, Ollama's server-side qwen
tool-call parsers (`qwen35.go` / `qwen3coder.go`) reject it with an XML syntax
error and **terminate the response stream**. The generated text exists — the
server logs the failure at `WARN`, not `ERROR` — but it is discarded rather than
surfaced, so the client receives a dead stream with no assistant content. A
malformed tool call is a recoverable condition; a killed stream is not. Emitting
the raw text as a normal assistant message (with no `tool_calls`) would let
client-side salvage layers recover the intended call.

### Environment

- **Ollama:** 0.30.10
- **Model:** `qwen3.6:latest` (36B, Q4 — ~23 GB resident)
- **Host:** macOS (Darwin 25.5.0), 34 GB unified memory; model pre-warmed
  (`keep_alive 30m`) before the run
- **Request shape:** `/api/chat` with `tools` **and** a structured-output
  `format` (constrained decode) in the same call, `stream: true`

### What happens

In a request that combines a **tool surface** with a **constrained structured
output** (`format`), `qwen3.6` intermittently emits malformed tool-call markup —
a `<function …>` element that is closed by a `</parameter>` tag (mismatched /
omitted close tag in the qwen tool-call XML). The server-side parser rejects it
and the stream dies before any assistant content reaches the client.

Reconstructed from the error string (the raw emission is server-side and not
returned to the client), the malformation is of this shape:

```
<tool_call>
<function=read_file>
<parameter=path>src/slug.ts   <-- parameter not closed before </function> is expected;
</function>                    the parser sees <function> "closed by" </parameter>
</tool_call>
```

The same model emits **well-formed** tool calls in a plain (non-constrained)
role — it is the `tools` + `format` combination that surfaces the defect.

### Server log

The two qwen parsers log the failure and then the stream ends:

```
level=WARN source=qwen3coder.go:71 msg="qwen tool call parsing failed"
  error="XML syntax error on line 3: element <function> closed by </parameter>"
level=WARN source=qwen35.go:105  msg="qwen3.5 tool call parsing failed" ...
```

### What the client sees

The stream is interrupted; the underlying error text is propagated but no
assistant message (and no `tool_calls`) is delivered. Across two attempts the
malformed markup landed on different lines, but the failure class was identical:

```
stream interrupted: XML syntax error on line 3: element <function> closed by </parameter>   (attempt 1)
stream interrupted: XML syntax error on line 4: element <function> closed by </parameter>   (attempt 2)
```

Reproducible on our stack: **2/2** attempts with `qwen3.6:latest` in this role
died this way; swapping only the model to `qwen3:8b`, `gemma4:12b`, or
`glm-4.7-flash` (identical transport, tool wiring, and schema) parsed cleanly and
completed. The failure isolates to this model's emissions through the
`qwen35.go` / `qwen3coder.go` parser path — **not** to the client, the tool
wiring, or local models generally.

### Minimal reproduction

A single `/api/chat` call with both `tools` and `format`, prompted to call a tool
before answering (this is the combination that triggers the malformed emission):

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "qwen3.6:latest",
  "stream": true,
  "messages": [
    { "role": "system",
      "content": "You are a code reviewer. Before answering you MUST call the read_file tool to inspect the workspace, then return your verdict." },
    { "role": "user",
      "content": "Judge whether src/slug.ts passes review. Call read_file first." }
  ],
  "tools": [
    { "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file from the workspace",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"]
        }
      }
    }
  ],
  "format": {
    "type": "object",
    "properties": {
      "verdict":   { "type": "string", "enum": ["approved", "rejected"] },
      "reasoning": { "type": "string" }
    },
    "required": ["verdict", "reasoning"]
  }
}'
```

The malformed emission is model-side and therefore stochastic — repeat the call a
few times if the first attempt parses. The same request against `qwen3:8b`
completes normally, which confirms the abort is in the parser's error handling,
not the request.

### Expected behavior

On a tool-call parse failure, **surface the generated text as a normal assistant
message** (empty or absent `tool_calls`) and let the stream complete, rather than
aborting it. The `WARN`-level log already shows the server treats this as a
non-fatal parse issue and still holds the raw output — so the content exists and
could be returned. A client that requested tools can then run its own recovery
(re-parse / repair the malformed markup into a tool call) instead of losing the
whole turn.

### Why this matters

Clients that drive tool loops over Ollama typically carry a salvage layer
precisely for malformed tool-call text — recover the intended call from the raw
assistant output and continue. That layer never gets the chance here, because the
failure is server-side and arrives as a dead stream, not as recoverable text.
Any transport that requests tool calls through this parser shares the failure
mode. Degrading to plain text on a parse failure turns a fatal, whole-turn loss
into a recoverable one, at no cost to the callers that don't need it (they still
see a tool-less assistant message and can decide what to do).

### The ask

Make a qwen tool-call parse failure **degrade to plain text** rather than
terminate the stream: emit the raw generated content as the assistant message and
keep the response well-formed. The parser already distinguishes this case
(`WARN "qwen tool call parsing failed"`); the change is to not kill the stream on
that branch.
