# Tool-handling strategy for a local code builder — prior art & synthesis

*Research brief feeding [volley-spec-v3.md](./specs/volley-spec-v3.md) §4 (builder tool surface), §5 (termination), and §6 (local-runtime reliability). Written 2026-07-07.*

The v3 spec hands the local builder a real `bash` tool plus a set of structured file tools (`read_file`/`write_file`/`edit_file`/…) and routes them through fascicle's native tool-calling loop. The prompt behind this brief was a specific challenge to that shape: **"just bash" is reportedly quite powerful and potentially all that is necessary.** This document tests that claim against academic, industry, and open-source prior art, and returns a recommendation.

**The claim is half right, and the useful half is not the half it sounds like.** "Just bash" is really two claims bundled together, and separating them is the whole point of this brief.

---

## TL;DR

1. **Disentangle two axes.** "Just bash" simultaneously asserts (A) *granularity* — one general `bash` tool beats a bespoke toolset — and (B) *encoding* — the model should emit actions the harness parses from text, not via the structured function-calling API. These are independent choices, and most of the confusion in the field comes from conflating them.

2. **On granularity (A), the pro-bash evidence is real but it is frontier-model evidence.** mini-swe-agent (bash-only, ~100 lines, >74% SWE-bench Verified) and Terminal-Bench's neutral `Terminus` agent show that *for a strong enough model*, an elaborate tool interface is unnecessary — the SWE-agent team say so in their own words, recanting their 2024 position. But the original SWE-agent ablations that motivated bespoke tools were run on GPT-4-Turbo, a model at roughly **today's local tier**, and the interface benefits were **largest for the weaker model** and **faded as models got stronger** — exactly the wrong direction for a local builder.

3. **On encoding (B), the local story inverts the frontier story.** For local models on Ollama/LM Studio, native JSON function-calling is a documented minefield (Qwen dialect mismatches; Ollama serializes tool defs as Go-struct strings; parallel calls unsupported; "not guaranteed to follow the protocol" per Qwen's own docs). The battle-tested answer every local-capable agent converges on — mini-swe-agent, Aider, Cline (pre-native), qwen-agent, Continue's fallback — is to **have the model emit its action as text and parse it in the harness.** Bash-as-a-fenced-code-block is the single most robust text action because every model has seen enormous amounts of shell in pretraining, it is one grammar to parse, and it sidesteps the JSON-escaping-of-source-code failure Aider measured.

4. **Recommendation for volley §4: keep bash *and* a few structured file tools; treat text-protocol encoding as a first-class mode, not a fallback.** Do **not** go pure-bash — a weak local model is precisely the case where the ACI guardrails (exact-match `edit_file`, bounded line-numbered reads, lint feedback) do the most work, and small local context windows punish `cat`-everything bash. But do **not** assume the tools ride fascicle's native `tools` array either: that path routes the weak model's every action through the exact Ollama/Qwen serialization bugs §6 already flags. The real §4/§6 decision is **transport, not tool list** — and the spec currently assumes native because that is what fascicle hands you.

5. **This reframes an open question the spec doesn't yet ask.** §4 asks "which tools" and §6 asks "is native tool-calling reliable on the pinned runtime." The prior art says those are the same question: if native calling is flaky on the pinned Qwen build (§6 says expect it to be), the mitigation is not a repair-retry loop bolted onto fascicle's tool array — it is a mini-swe-agent-shaped inner loop that parses a `bash`+edit text protocol, running *inside* the single `generate()` call. Pin that as a supported path, or accept a reliability ceiling.

---

## 1. The question, disentangled: two axes people conflate

Almost every "just bash vs. rich tools" argument in the literature is really moving along two independent axes at once:

| Axis | Question | Endpoints |
|---|---|---|
| **A — Granularity** | How many, how specialized are the actions? | One general `bash` tool ⟷ a bespoke toolset (`read`/`write`/`edit`/`search`/`view`…) |
| **B — Encoding** | How does the model express an action on the wire? | Native function-calling (JSON `tools` array, runtime parses `tool_calls`) ⟷ the model emits text (a fenced `bash` block, a diff, XML tags) that **the harness** parses |

The two axes are orthogonal. You can have a single bash tool over native function-calling (mini-swe-agent v2 default), a single bash action parsed from a markdown fence (mini-swe-agent v1), a rich toolset over native calling (Claude Code, OpenHands), or a rich set of edit *formats* parsed from text (Aider). "Just bash" as a slogan bundles the minimal end of **both** axes — but the evidence for each is different, and, decisively for volley, **the frontier→local shift pushes the two axes in opposite directions.** Keeping them separate is what makes the rest of this brief tractable.

---

## 2. Axis A — granularity: is bash *all* you need?

### 2.1 The pro-bash evidence (strong — and almost entirely frontier-model)

**mini-swe-agent** (Princeton/Stanford SWE-agent team) is the flagship artifact. It is ~100 lines, gives the model *only* bash, edits files with heredocs and `sed`, runs each action as an independent `subprocess.run` (no persistent shell), and scores **>74% on SWE-bench Verified** — a few points below heavily-optimized agents. ([repo](https://github.com/SWE-agent/mini-swe-agent), [docs](https://mini-swe-agent.com/latest/)). The maintainers' own framing is the strongest statement of the thesis, and it is a public recantation of their own 2024 work:

> "[SWE-agent] placed a lot of emphasis on tools and special interfaces for the agent. However, one year later, as LMs have become more capable, a lot of this is not needed at all to build a useful agent!" ([README](https://github.com/SWE-agent/mini-swe-agent/blob/main/README.md))

Corroborating evidence that minimal scaffolds match or beat elaborate ones **on strong models**:

- **Terminal-Bench** ships a deliberately neutral reference agent, `Terminus`, with *one tool* — a bash/tmux pane — precisely so no scaffold can be tuned to a model. On the live Terminal-Bench 2.0 board (fetched 2026-07), Claude Opus 4.6 spans **58.0%–76.4% across seven scaffolds — an 18.4-point spread from scaffold choice alone** — and the neutral bash-only Terminus (62.9%) **beats Anthropic's own "Claude Code" scaffold (58.0%)** for that model. ([tbench.ai leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.0), [ICLR 2026 paper](https://arxiv.org/html/2601.11868v1))
- **swebench.com** now standardizes cross-model comparison on bash-only mini-swe-agent — *"No tools, no special scaffold structure"* — because a rich scaffold would distort the ranking of raw model capability. ([verified.html](https://www.swebench.com/verified.html)) The benchmark authority treats bash-only as the *neutral* interface.
- **Anthropic's own** SOTA scaffold for Claude 3.5 Sonnet used **two tools** (bash + an edit tool), philosophy: *"keep the scaffolding minimal."* ([swe-bench-sonnet](https://www.anthropic.com/research/swe-bench-sonnet)) Note: two, not one — even Anthropic's minimal did not drop the edit tool. Hold that thought.

The mechanistic argument for bash is genuine: shell composition (pipes, loops, `&&`) lets one action express what several tool calls would take, and the model has seen vast amounts of shell in pretraining. The stateless-`subprocess.run` design is also a direct gift to volley's §3: *"literally just switch out `subprocess.run` with `docker exec`"* is exactly shape (B) (harness on host, bash execs into container), done statelessly so there is no cwd/env drift to reconcile.

### 2.2 The counter-evidence: the ACI thesis — and it is *stronger* for weak models

The original **SWE-agent paper** ("Agent-Computer Interfaces Enable Automated Software Engineering," NeurIPS 2024, [arXiv:2405.15793](https://arxiv.org/abs/2405.15793)) is the rigorous counter-argument, and its ablations are the most-cited numbers in the field. On SWE-bench Lite with **GPT-4-Turbo**:

| ACI element ablated | Resolved | vs. default 18.0% |
|---|---|---|
| **No edit tool** (raw shell editing, i.e. heredoc/`sed`) | 10.3% | **−7.7** |
| Edit tool *without* linting guardrail | 15.0% | −3.0 |
| File viewer showing full file (`cat`) instead of 100-line window | 12.7% | −5.3 |
| No search summarization | 12.0% | −6.0 |
| **Full ACI (default)** | **18.0%** | — |

The single biggest lever is a **dedicated `edit` tool** (+7.7 over raw-shell editing), and its most valuable feature is a **linter guardrail**: the edit is applied, `flake8` runs, and if it introduces a syntax/undefined-name error the edit is **reverted** and the model is shown a structured three-part diagnostic. The paper's four ACI principles — actions *simple*, actions *compact*, feedback *informative but concise*, and *guardrails to hasten error recovery* — are the design counterweight to "just bash." ([ACI docs](https://swe-agent.com/0.7/background/aci/))

Anthropic's tool-design guidance says the same at the level of principle: *"invest just as much effort in creating good agent-computer interfaces (ACI)"* as human UIs; *"poka-yoke your tools"* (e.g. force absolute paths so a class of error becomes structurally impossible). ([building-effective-agents](https://www.anthropic.com/research/building-effective-agents), [writing-tools-for-agents](https://www.anthropic.com/engineering/writing-tools-for-agents))

Three facts make this counter-evidence **more** relevant to a local builder than to a frontier one:

1. **The ablations are GPT-4-Turbo-era.** That model is roughly at *today's strong-local tier* by benchmark. The interface helped it by 7.7 points. The SWE-agent team's stated reason the interface later became unnecessary is *"as LMs have become more capable"* — i.e. the benefit is a **decreasing function of model strength**, and a local builder sits on the high-benefit end of that curve.
2. **Bash is not universally sufficient even for strong models.** Vercel's "testing if 'bash is all you need'" ran a structured-data-query task three ways: a purpose-built SQL tool hit **100%** accuracy; bash-only hit **52.7%** at ~7× the tokens and ~6.5× the cost. ([Vercel](https://vercel.com/blog/testing-if-bash-is-all-you-need)) Bash-only is task-dependent, and it is token-hungry — which matters acutely locally (see §2.3).
3. **The answer is "few, well-chosen," not "zero" and not "many."** Tool-*space* interference is also real: Microsoft Research and others document large tool sets degrading selection accuracy, and adaptive short-lists of ~7 tools matching the coverage of 50. ([MSR](https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/)) So the target is a *handful* of high-value tools — which is exactly the shape of the v3 §4 set, not pure-bash and not a sprawling toolbox.

### 2.3 The frontier→local inversion

Every pro-bash headline number in §2.1 is a frontier model (Claude Opus/Sonnet, GPT-5.x, Gemini 3). The local picture is different in kind, not just degree:

- On Terminal-Bench 2.0, the best *open* model found (GLM-5, 52.4%) trails the best overall (~76–85%) by **25–45 points**; Qwen3-Coder-480B is at 27.2%. ([tbench.ai](https://www.tbench.ai/leaderboard/terminal-bench/2.0)) On SWE-bench Verified the open gap is narrower but the **scaffold dependence is larger**: Qwen3-Coder-480B scores **55.4% under bash-only mini-swe-agent but 69.6% under OpenHands** — a **14-point swing on identical weights** from scaffold alone. ([swebench.com](https://www.swebench.com/))
- Mistral's **Devstral** was explicitly *trained against a scaffold* (OpenHands) and is benchmarked *"under the same test scaffold,"* where a 24B model beats far larger ones. ([mistral.ai/news/devstral](https://mistral.ai/news/devstral/)) The scaffold is part of the model's identity, not incidental.
- Practitioners report a hard floor: Cline's own testing found *"models smaller than Qwen3 Coder 30B consistently fail with Cline, producing broken outputs or refusing to execute commands properly."* ([cline.bot/blog/local-models-amd](https://cline.bot/blog/local-models-amd)) OpenHands warns local models give *"limited functionality"* and *"may struggle with reliable tool use,"* degrading to chatbot behavior. ([docs](https://docs.openhands.dev/openhands/usage/llms/local-llms))
- **Context frugality is not optional locally.** Ollama's *default* context is small (OpenHands warns *"not even the system prompt will fit"* at 4096; Aider auto-raises `num_ctx` because Ollama *"silently discards"* overflow). The SWE-agent result that a bounded 100-line file view beats `cat`-the-whole-file (12.7% → 18.0%) is a *context-management* result — and context is the scarcest resource on local hardware. `cat`-everything bash is actively harmful here.

**Reading of Axis A:** minimal-bash is a luxury purchased by frontier capability. For volley's deliberately-weak local builder, the ACI guardrails are doing real work, the marginal file tools are cheap (they already exist for the critic), and the context discipline they enforce is worth more locally than anywhere. Bash is *necessary* — it is the general actuator and, per §9, the only way the builder can run `checkride` to self-verify — but it is not demonstrably *sufficient*, and the cost of not finding out is a phase's worth of thrash.

---

## 3. Axis B — encoding: native function-calling vs. parse-from-text

This is where "just bash" earns its keep for volley, for a reason unrelated to granularity.

### 3.1 The local tool-calling minefield

The v3 §6 already flags Ollama's tool-serialization bug and Qwen3-Coder's distinct dialect. The research confirms both and shows they are the tip of a large, well-documented iceberg — this is a *class* of problem, not a bug or two:

- **Qwen speaks two incompatible tool dialects.** Qwen3 (dense/MoE) uses Hermes-style `<tool_call>{"name":…,"arguments":…}</tool_call>` JSON; **Qwen3-Coder** uses `<tool_call><function=name><parameter=…>value</parameter></function></tool_call>` — XML parameter tags, not JSON. They require *different* runtime parsers (`hermes` vs `qwen3_xml`/`qwen3_coder`), and crossing them **silently drops tool calls.** Verified against both models' own `tokenizer_config.json` chat templates and vLLM's parser docs. ([Qwen function_call docs](https://qwen.readthedocs.io/en/latest/framework/function_call.html), [vLLM tool_calling](https://docs.vllm.ai/en/latest/features/tool_calling/)) The flag name itself drifted (`qwen3_coder` → `qwen3_xml` across vLLM versions) — a live version-sensitivity gotcha.
- **Qwen's own docs disclaim reliability:** *"It is not guaranteed that the model generation will always follow the protocol even with proper prompting or templates… be prepared that if it breaks, countermeasures or rectifications are in place."*
- **Ollama has a wall of confirmed, still-open tool-calling bugs:** tool defs rendered as Go-struct strings instead of JSON in the shipped Qwen3 template ([#14601](https://github.com/ollama/ollama/issues/14601)); Qwen3.5 tool calling *"completely non-functional"* from a renderer/parser mismatch ([#14493](https://github.com/ollama/ollama/issues/14493)); `content:""` assistant turns breaking multi-turn templates so the model falls back to text-markup calls ([#14181](https://github.com/ollama/ollama/issues/14181)); parallel tool calls unsupported ([#9156](https://github.com/ollama/ollama/issues/9156)); models emitting tool calls as raw JSON *text* instead of the structured field ([#11662](https://github.com/ollama/ollama/issues/11662)).
- **LM Studio is the same architecture** (server-side prompt-injection + text-parsing behind an OpenAI-compatible endpoint), with the same class of failures — Qwen3-Coder XML unparsed ([#825](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/825)), `tool_choice:"required"` dumping calls into `content` ([#2115](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2115)). The community claim that LM Studio is "more reliable" than Ollama rests on a single GitHub anecdote plus SEO blogs — **treat it as unverified**; both are prompt-injection-plus-text-parsing under the hood.

The through-line: on local runtimes, "native function-calling" is *itself* prompt-injection-and-text-parsing wearing an OpenAI-shaped coat — and the coat is buggy, per-model, and version-fragile.

### 3.2 What local-capable agents actually do: parse from text

Faced with this, the agents that genuinely target local/open models converge on the same move — **skip the runtime's tool-call machinery and parse the model's text yourself**:

- **mini-swe-agent:** *"Does not have any tools other than bash — it doesn't even use the tool-calling interface of the LMs. This means that you can run it with literally any model."* It ships **three interchangeable encodings for the identical loop** — native `tool_calls`, markdown-fence parsing, and XML-tag parsing — direct evidence the team treats encoding as a swappable reliability knob. ([FAQ](https://mini-swe-agent.com/latest/faq/))
- **Aider** *benchmarked* function-calling against text and **rejected it**: *"Even though OpenAI provides extensive support for structured formats like json and function calls, GPT is worse at editing code if you use them"* — because escaping source into JSON *"is pretty painful and error prone… GPT's code is often syntactically incorrect when it's unpacked from JSON, or the JSON decode just fails entirely."* Text diffs win; Aider defaults *lesser-known/local* models to the simplest whole-file format. ([edit-formats](https://aider.chat/docs/more/edit-formats.html), [unified-diffs](https://aider.chat/docs/unified-diffs.html))
- **Cline/Roo Code** are the cautionary tale. Both began as XML-in-text (maximally model-agnostic), then migrated to native calling for frontier reliability (Roo's RFC: XML tool calls failed ~10% of the time, `apply_diff` >15%) — and **that migration broke local models.** Roo now *filters out* Ollama models without native tool support; there is an open bug from a user whose self-hosted model lost the XML fallback with nothing to replace it. ([Roo RFC #4047](https://github.com/RooCodeInc/Roo-Code/issues/4047), [#11187](https://github.com/RooCodeInc/Roo-Code/issues/11187), [Cline v3.35](https://cline.bot/blog/cline-v3-35)) The reliability gain of native calling is real *for models trained on it* and negative for those not.
- **qwen-agent** (Qwen's own framework) prefers to **parse tool output itself** rather than trust the runtime's native parser — it explicitly recommends *not* enabling vLLM's `--tool-call-parser` so *"Qwen-Agent will parse the tool outputs on its own."*
- **Continue** keeps native calling as default but ships an explicit text/XML fallback *"so any model capable of following instructions can use tools, not just those with native tool support."*
- **BAML's** schema-aligned-parsing argument generalizes it: prompt-plus-parse *"works on Day 1 of any model release, without waiting for provider support for tool-calling,"* and function-calling *"often ha[s] degraded accuracy… compared to just prompting."*

### 3.3 Why bash-as-text is the most robust text encoding — and where code-as-action lands

Given "parse from text," bash-in-a-fenced-block is the strongest choice: every model has seen enormous shell in pretraining (smolagents: models are *"more fluent in code-writing than in JSON writing"*); it is a *single* grammar to parse (one fenced block, not a per-tool schema); and it sidesteps JSON-escaping-of-source entirely.

The **CodeAct** line ("Executable Code Actions Elicit Better LLM Agents," ICML 2024, [arXiv:2402.01030](https://arxiv.org/abs/2402.01030)) is the maximal version — emit *Python* as the action — and reports up to **20% higher success and ~30% fewer turns** than JSON/text. It is what OpenHands' `CodeActAgent` is built on. But two findings keep it from being a slam-dunk for a weak local builder:

- **It needed a strong model or fine-tuning.** Prompting alone, the best *open* model tested (Lemur-70B) scored **13.4%** on M3ToolEval where GPT-4 scored 74.4% — and on that open model **JSON (15.9%) actually beat CodeAct (13.4%).** The authors' fix was a dedicated fine-tune (CodeActInstruct), not "just use code." Code-as-action is not automatically better for weak models.
- **Freeform code is hard to constrain.** CODESTRUCT ([arXiv:2604.05407](https://arxiv.org/abs/2604.05407)) argues unconstrained code actions are unreliable *specifically for weaker models*, and that a constrained (AST-validated) action space helps them more — the same instinct as SWE-agent's linter guardrail. And code-as-action *requires* the sandbox the spec already mandates (arbitrary exec).

So the sweet spot for a weak local builder is **narrower than full CodeAct and wider than pure-bash**: bash as the general actuator (parsed from a fence), plus a *small* set of structured, guardrailed edit/read actions — expressed in whatever encoding survives the pinned runtime.

---

## 4. Synthesis for volley

### 4.1 The four quadrants, and where everyone sits

Placing the surveyed systems on both axes makes volley's choice legible:

| | **Native function-calling** (runtime parses `tool_calls`) | **Parse-from-text** (harness parses model output) |
|---|---|---|
| **Bash-only / minimal** | mini-swe-agent v2 default (1 bash tool); Terminus | **mini-swe-agent v1** (bash from a markdown fence) |
| **Few structured tools** | **Claude Code**, OpenHands, Cline/Roo *(current)*, Continue *(default)*, **← volley v3 §4 as written**, volley critic | **Aider** (diff/whole formats), Cline/Roo *(original)*, Continue *(fallback)*, qwen-agent |

Two observations decide the matter:

- **volley's critic already lives in the top-left-ish cell** (structured read-only tools over fascicle's native `generate` loop), and it works because the critic is single-shot, read-only, and — in the all-Claude case — frontier. The v3 builder as written simply extends that cell down-left (add bash + write/edit). That is the *path of least resistance*, and it is the **wrong cell for a weak local model**: every agent in the right-hand column got there *specifically* to serve local/weak models, and every agent that left it (Cline/Roo) broke them.
- **No surveyed system relies on the model driving `sed`/`patch` through a generic shell as its primary edit path.** Even Aider, which parses *everything* from text, constrains that text to a rigid diff/whole-file grammar. Pure-bash editing (heredocs + `sed`, mini-swe-agent style) is a frontier-model affordance; the field's consensus edit mechanism is a *structured* edit, whether encoded as native call or as text.

### 4.2 The tension the spec doesn't yet name

The spec's §4 asks *which tools* and §6 asks *is native calling reliable on the pinned runtime*. The prior art collapses these into one question: **transport.**

fascicle's `engine.generate` is a *native-tool-calling* loop — `tools: Tool[]`, `StepRecord[]`, `finish_reason`, `tool_error_policy`, `schema_repair_attempts`. Exposing bash + file tools through it (the natural, critic-mirroring implementation the spec assumes) routes the weak local model's **every action** through precisely the Ollama/Qwen serialization path §3.1 documents as broken. §6's `schema_repair_attempts` + return-not-throw `tool_error_policy` is a real mitigation for the *occasional* malformed call — but the failures above are not occasional-and-random, they are *systematic and per-model* (wrong dialect, wrong serialization, no parallel support). Retry does not fix a template that emits Go-struct strings.

The field's answer — parse a text protocol — means **not using fascicle's tool array for the local builder.** That is an architectural fork, and it is bigger than the tool list. The spec should decide it deliberately rather than inherit "native" by default because that is what the substrate makes easy.

### 4.3 Recommendation

**Granularity — keep bash *and* a few structured tools (do not go pure-bash).**

- **`bash` stays, as the general actuator** (spec is right): it is required for the local-builder + checkride combination (§9), and it carries the composition/pretraining-familiarity benefits. Make it **stateless per-action** (mini-swe-agent's `subprocess.run` model) so it maps cleanly onto §3 shape (B) as `docker exec` per command and there is no cwd/env drift to reconcile between the bash tool and the file tools (this also resolves part of §12 Q2).
- **Keep `read_file`/`write_file`/`edit_file`** — reuse the critic's `contain()`'d tools; marginal cost is near-zero and the ACI evidence says they earn their place *more* on a weak model. Specifically:
  - `read_file` must be **bounded and line-numbered** (SWE-agent: 100-line window ≫ full-file `cat`), not a passthrough — this is a *context-budget* control, and context is scarcest locally.
  - `edit_file` should carry the **highest-leverage ACI guardrail**: exact-match-or-fail (`old_str` must appear exactly once → `new_str`, the Anthropic/`str_replace` contract Claude Code uses) *plus* an optional **lint-on-edit** that feeds a checkride-adjacent syntax check back as a normal tool result and rejects edits that break the parse (SWE-agent's +7.7-point mechanism; Aider's auto-lint-and-repair). This is the single change most likely to keep a weak model out of an edit-thrash spiral.
- **Do not add more than this handful** (tool-space interference is real). bash + read + write + edit + `fetch` + `finish` is already at the sensible ceiling.

**Encoding — pin the dialect first; make text-protocol a first-class supported mode.** *(Update — fascicle 0.8.13 shipped `tool_call_repair_attempts` (native-tool-call salvage from Hermes/`json`/Qwen3-Coder-XML text, gated on schema validation) and `max_tool_calls_per_step`. That makes **native + salvage the Tier-1 default** and demotes the text-protocol to the deeper Tier-2 fallback; the swappable-encoding advice below still holds, but the swap is native+salvage → text-protocol, not native → text-protocol.)*

- **Pin model + runtime + parser as one unit** before anything else (§6/§8). Either Qwen3-family + a `hermes`-parser runtime, or Qwen3-Coder + a `qwen3_xml`/`qwen3_coder` parser — **never cross them.** LM Studio's cleaner Qwen path is a reasonable default transport, but verify it on the *specific* pinned build, not on reputation.
- **Design the builder loop so its encoding is swappable, exactly as mini-swe-agent does.** Attempt fascicle's native `tools` path on the pinned runtime; if §3.1's failure modes show up (expect them on some builds), fall back to a **text protocol parsed by volley**: a single `bash` fenced block plus a structured edit grammar (diff or `old_str/new_str`), with the tool contract described in the `harness_append_local` system prompt (§4 already calls for this prompt — this makes it load-bearing, not cosmetic). This is a mini-swe-agent-shaped inner loop running *inside* the one `generate()` call, so it does not perturb the outer `loop`'s round accounting or the fresh-context-per-iteration guarantee (§12 Q10 holds either way).
- **Termination (§5) rides the same seam.** A text protocol has a naturally robust finish convention — a sentinel first line (mini-swe-agent's `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`) or a `finish` fenced block — that does **not** depend on the weak model emitting a well-formed `finish()` *JSON tool call*. If the builder runs native, `finish` is a tool; if it runs the text protocol, `finish` is a sentinel. Both satisfy the LOCKED "both `max_steps` and explicit `finish`" decision; the text form is strictly more robust on a flaky runtime. Recommend the spec state `finish` abstractly (a signal) and let the transport determine its concrete shape.

**One honest cost for the comparison goal (§8).** If all-Claude runs native tools (via `claude_cli`) and all-local runs a text protocol, the transport differs *in addition to* the provider — another confound to name alongside the §3 containment-mechanism and §4 tool-surface asymmetries the spec already lists. "Fair" continues to mean *controlling the task, not the machinery.* The finding to record is not "who won" but *where the local model got stuck and whether it was the model or the transport* — which is exactly the instrument §1 wants volley to be.

---

## 5. Caveats on this brief

- **Most pro-bash numbers are frontier + dated snapshots.** Terminal-Bench/SWE-bench leaderboards and several model names here (Opus 4.6, GPT-5.x, Qwen3.6, GLM-5) are live-fetched 2026-07 and move weekly; re-verify against tbench.ai / swebench.com at implementation time. The *directional* findings (scaffold matters more as models weaken; local tool-calling is a per-model minefield; text-parsing is the local escape hatch) are stable; the exact percentages are not.
- **Some scaffold-swing figures are self-reported or community-sourced** (e.g. a Qwen3.6-27B "67.8% bash-only vs 90% engineered-harness, same weights" GitHub claim) and are flagged as such — used only as directional corroboration of the audited 14-point Qwen3-Coder-480B mini-swe-agent↔OpenHands swing, never as primary evidence.
- **mini-swe-agent v2 nuance:** its current *default* uses native tool-calling with a single `bash` tool; the "doesn't use the tool-calling interface" claim describes v1 and the still-shipped text-parsing mode. This actually *reinforces* the two-axis framing — the same project demonstrates that granularity (one bash tool) and encoding (native vs. text) are independent knobs.

---

## Appendix — key sources

**Academic**
- SWE-agent / ACI thesis + ablations — [arXiv:2405.15793](https://arxiv.org/abs/2405.15793) · [ACI docs](https://swe-agent.com/0.7/background/aci/)
- CodeAct (code-as-action) — [arXiv:2402.01030](https://arxiv.org/abs/2402.01030)
- CODESTRUCT (constrained actions help weak models) — [arXiv:2604.05407](https://arxiv.org/abs/2604.05407)
- Tool-space interference — [MSR blog](https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/)
- Terminal-Bench — [arXiv:2601.11868](https://arxiv.org/html/2601.11868v1) · [tbench.ai](https://www.tbench.ai/)

**Industry / vendor**
- Anthropic: [building-effective-agents](https://www.anthropic.com/research/building-effective-agents) · [writing-tools-for-agents](https://www.anthropic.com/engineering/writing-tools-for-agents) · [swe-bench-sonnet](https://www.anthropic.com/research/swe-bench-sonnet) · [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
- Mistral Devstral (trained-to-scaffold) — [mistral.ai/news/devstral](https://mistral.ai/news/devstral/)
- Vercel "is bash all you need" — [vercel.com/blog](https://vercel.com/blog/testing-if-bash-is-all-you-need)

**Open-source agents**
- mini-swe-agent — [repo](https://github.com/SWE-agent/mini-swe-agent) · [FAQ](https://mini-swe-agent.com/latest/faq/)
- OpenHands — [runtime](https://docs.openhands.dev/openhands/usage/architecture/runtime) · [local-llms](https://docs.openhands.dev/openhands/usage/llms/local-llms)
- Aider — [edit-formats](https://aider.chat/docs/more/edit-formats.html) · [unified-diffs](https://aider.chat/docs/unified-diffs.html) · [benchmarks](https://aider.chat/docs/benchmarks.html)
- Cline / Roo — [v3.35 native migration](https://cline.bot/blog/cline-v3-35) · [Roo RFC #4047](https://github.com/RooCodeInc/Roo-Code/issues/4047) · [local-models-amd](https://cline.bot/blog/local-models-amd)
- smolagents — [secure code execution](https://huggingface.co/docs/smolagents/en/tutorials/secure_code_execution) · qwen-agent — [function_call docs](https://qwen.readthedocs.io/en/latest/framework/function_call.html)

**Local-runtime reliability (the encoding minefield)**
- Qwen dialects/parsers — [Qwen docs](https://qwen.readthedocs.io/en/latest/framework/function_call.html) · [vLLM tool_calling](https://docs.vllm.ai/en/latest/features/tool_calling/)
- Ollama bugs — [#14601](https://github.com/ollama/ollama/issues/14601) · [#14493](https://github.com/ollama/ollama/issues/14493) · [#14181](https://github.com/ollama/ollama/issues/14181) · [#9156](https://github.com/ollama/ollama/issues/9156)
- LM Studio bugs — [#825](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/825) · [#2115](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2115)
- Benchmarks for open models — [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html) · [swebench.com](https://www.swebench.com/)
