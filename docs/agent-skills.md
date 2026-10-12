# Tandix agent skills and tasks (v1)

This contract is separate from `traceforge.task/v1`, the planned deterministic browser-replay format. An **agent skill** is reusable, reviewable guidance for an AI agent; a **task** is one invocation of a skill with concrete inputs and a target browser context. One skill can serve many tasks. A recording is evidence used to author a skill, not an executable instruction stream.

## Skill: `tandix.agent-skill/v1`

The portable artifact is one UTF-8 JSON file conforming to `schemas/agent-skill.schema.json`. It contains an ID, name, goal, ordered semantic steps, success criterion, typed input parameters, provenance, an origin policy, and optionally a reviewed `startUrl`. Steps describe *what* to do (for example “find the feedback record by phone number”), not historical snapshot indices. Credentials, typed secret values, cookies, signed URL parameters, and record-specific start URLs must never be embedded. `allowedOrigins: []` means only the currently controlled origin; broader origins require review. A `startUrl` must belong to `allowedOrigins` and does not bypass the browser's existing approvals.

The AI may propose a draft, but Tandix validates its shape and the user must review it before the skill is trusted. When evidence is insufficient, the AI must return questions instead of inventing selectors, download URLs, or success conditions. The skill revision changes when its behavior changes.

Run can download a saved skill as a ZIP containing `SKILL.md`, `references/execution-modes.md`, and `references/tandix-skill.json` for re-import. Runtime input values are not included. A skill is command-line capable only when its reviewed JSON contains `desktopAdapter`; those archives additionally contain an executable `scripts/run.mjs` that calls the declared HTTP requests and reads authentication from an environment variable. Without an adapter, the archive explicitly identifies itself as browser-only and contains no runner. A browser demonstration does not prove that a browser-free API exists, so Tandix never fabricates private endpoints or turns historical selectors into a replay script.

## Task: `tandix.agent-task/v1`

A task references a skill ID and revision, supplies runtime input bindings, identifies the target (`controlled-tab` inside Tandix or `agent-runtime` for a portable desktop Agent), and may narrow—not widen—the skill's origin policy. Secret bindings are not persisted in a skill. In v1, runtime inputs are sent to the connected AI agent as prompt content and may remain in that conversation's history; do not supply credentials that must not be shared with the agent. A run result is separate from both artifacts: it records completed/failed steps, observed evidence, unresolved questions, and final verification. Failure to satisfy the success criterion is a failed or incomplete task, not a successful tool call.

## Shared AI workflow

1. **Extract in Chat:** While the side panel is open, Tandix keeps at most ten minutes or 200 recent page events in memory. The “提炼技能” button sends the complete bounded timeline with absolute timestamps, offsets, inter-event intervals, tab/frame context, semantic targets, and redacted navigation/network/download metadata. Typed values are represented only by placeholders and length metadata. Tandix does not pre-classify or remove operations; `prompts/agent-skill-chat.md` asks the AI to identify the latest coherent task, distinguish effective steps from exploration/retries, and minimize run-time inputs rather than parameterizing every touched control.
2. **Clarify and review:** For a non-trivial workflow, the AI asks up to three grouped questions when it is unclear which observed values should stay fixed and which should change on every run, or when output and side effects are ambiguous. Confirmed fixed selections are embedded in semantic steps; only confirmed variables become run-time parameters. Every complete draft remains visible for review. The AI interprets subsequent natural-language replies and emits a structured `save` intent when the user approves the skill; only then does the host persist it and report success. The UI confirmation button performs the same host action directly. A CLI can independently produce the same JSON file through `prompts/agent-skill-extract.md` and Run can import it for review.
3. **Run:** Tandix builds a task from the chosen skill and runtime inputs, then passes both to `prompts/agent-skill-run.md`. The AI treats the Tandix-controlled tab as the default execution surface: it reuses the page when suitable or navigates that same tab to the reviewed `startUrl`. It follows another matching tab only when the controlled tab is unavailable, and opens a new tab only when neither a controlled nor matching tab exists. It then refreshes the page snapshot, resolves targets on the live page, stays within `allowedOrigins` and browser approval policy, asks before ambiguity/high-impact actions, and verifies the success condition. Historical element indices are never replayed. Legacy skills without `startUrl` may follow a matching open tab only when their origin policy identifies it; they cannot invent a missing page URL.

The prompts are provider-neutral. The extension does not store a separate model API key; it uses the connected Codex or DSH agent. The CLI prints the same prompt for any AI command-line agent and validates the returned JSON before import.

For retrospective inference from a long, interleaved history before selecting a workflow to extract, see [activity inference](activity-inference.md). That experimental read-only CLI lets an Agent investigate non-contiguous task fragments, data-source hypotheses and counter-evidence. It does not expand the side panel's recording window or automatically save a Skill.

## CLI route

From the repository root:

```sh
pnpm skill prompt-extract --evidence redacted-trace.txt > extract-prompt.txt
# Give extract-prompt.txt to an AI CLI; save its JSON-only reply as ai-draft.json.
pnpm skill finalize --draft ai-draft.json --output feedback-skill.json
# In Run, import feedback-skill.json and review it.
pnpm skill prompt-run --skill feedback-skill.json --task feedback-task.json > run-prompt.txt
# Give run-prompt.txt to an AI CLI with browser access.
```

The evidence file must already be reviewed/redacted before sending it to an AI service. `finalize` refuses unresolved questions and will not overwrite an existing output file. A task file follows `schemas/agent-task.schema.json`; for example:

```json
{
  "schemaVersion": "tandix.agent-task/v1",
  "id": "run-001",
  "skillId": "<id from feedback-skill.json>",
  "skillVersion": 1,
  "inputs": { "phone": "18623" },
  "target": { "kind": "controlled-tab" },
  "requestedAt": 1790220000000
}
```
