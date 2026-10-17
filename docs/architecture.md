# TraceForge architecture

> Turn browser traces into reliable agent tasks.

TraceForge builds on `omdsh-dev/dsh-browser` without replacing its text-only browser tools or security model. DeepSeek Harness remains the Agent Host and the only place where model credentials belong. The browser extension owns the Side Panel, page-local capture, durable browser data, and eventual deterministic execution.

## Phase-one vertical slice

```text
Side Panel
  Chat | Teach | Clarify | Run
            │ recording.start / stop / export
            ▼
MV3 background service worker
  RecordingService ── RecordingStore ── IndexedDB
       │                    │
       │ control            └─ metadata + ordered events
       ▼
content script in each recorded frame
  DomRecorder ── page-side redaction ── bounded event payload
       ▲
       └─ click, input/change, select, submit, keydown

browser events ── navigation, tab activation/update/close ──► RecordingService
```

The existing path remains unchanged:

```text
Side Panel Chat ◄─port─► background SW ◄─authenticated WS─► dsh bridge plugin
                              │
                              └─ DSH_ACTION ─► content script snapshot/actions
```

## Module boundaries

- `src/content/recorder.ts` is the privacy boundary. It observes trusted user DOM events, creates bounded selectors and target hints, and replaces sensitive values with `{{secret}}` before calling `chrome.runtime.sendMessage`. Plain printable `keydown` events are omitted because `input` captures the result and raw keys could disclose secrets.
- `src/recording/schema.ts` is the runtime recording contract. Every page-authored payload is parsed and bounded again in the service worker. The exported schema version is `traceforge.recording/v1`.
- `src/recording/state-machine.ts` defines the Teach lifecycle: `idle → arming → recording → stopping → recorded`, plus `error` and restore transitions.
- `src/recording/store.ts` is the IndexedDB adapter. Metadata and each event are updated in one read-write transaction, so sequence numbers and summaries survive MV3 worker suspension.
- `src/background/recording-service.ts` coordinates tabs/frames, appends browser-level events, restores unfinished recordings, re-arms content scripts after a worker restart, and produces JSON/JSONL exports.
- `src/task/schema.ts` defines the future compiler output, `traceforge.task/v1`. Phase one intentionally does not guess arbitrary-site API semantics or claim that raw traces are ready-to-run tasks.
- `src/panel/TeachPanel.tsx` presents start/stop, a live red recording state, the stopped summary, and exports. Clarify and Run are explicit placeholders for the next phases rather than simulated functionality.

Machine-readable contracts live in `schemas/recording.schema.json` and `schemas/task-spec.schema.json`.

## Recording model

A recording has immutable identity/start context, a lifecycle status, recorded tab ids, a continuously updated summary, and ordered events. DOM events carry a resilient selector plus optional semantic hints (`role`, accessible label, short text). Browser events add normalized tab/frame metadata.

Supported phase-one event kinds:

- `click`
- `input` and `change`
- `select`
- `submit`
- non-printable or modified `keydown`
- committed `navigation`
- `tab` initial/activated/updated/closed

JSON exports contain one recording object with an `events` array. JSONL exports start with a recording header followed by one event per line, which is suitable for streaming compilers and large demonstrations.

## Privacy and trust boundaries

Sensitive form values are never sent to the service worker. Password inputs, credit-card autocomplete fields, and fields whose id/name/label matches the existing dsh-browser sensitive patterns become:

```json
{ "kind": "secret", "parameter": "password", "placeholder": "{{secret}}" }
```

The background parser does not trust the content-script payload merely because it came from the extension: strings and arrays are normalized and capped before storage. URLs are limited to HTTP(S). Model API keys are out of scope for extension storage and remain in DeepSeek Harness settings/credential providers.

This phase records literal non-sensitive inputs. The compiler must later ask the user which literals should become parameters; it must never silently promote secrets back into literals.

## MV3 lifecycle

IndexedDB, not worker memory, is authoritative. On startup the recording service loads the most recent active recording. If one exists it restores the Teach state and sends recording-control messages to every known tab/frame. A newly loaded content script also asks whether its tab belongs to the active recording. Event append, sequence allocation, summary update, and metadata update occur within one IndexedDB transaction.

Protected browser pages cannot host a content script. TraceForge still records browser-level tab/navigation metadata where the platform exposes it, and the UI does not claim DOM coverage for those pages.

## Future DSH Teach Plugin boundary

The current Chat → Run agent-skill path is separate from the deterministic TaskSpec compiler below. It uses the provider-neutral contracts and prompts in [agent-skills.md](agent-skills.md): an AI drafts semantic, parameterized instructions from selected chat/recording evidence, the user confirms the draft, and the connected agent executes a concrete task against a fresh browser snapshot. The same prompt files are exposed by the CLI. This path does not claim deterministic replay or verified selector generation.

In Chrome, both instruction and workflow skills persist in the OS user's `~/.tandix/skills/library.json`, through fixed Native Messaging storage operations. Extension-local data is an automatic migration source and cache. Atomic writes, cross-process locking, a previous-version backup, and deletion tombstones preserve skills across installation paths and extension IDs. Skill storage does not start an Agent. See the [skill library migration and backup instructions](agent-skills.md#persistent-skill-library-chrome).

## Webpage file-task API

The Chrome extension exposes a versioned external Port (`tandix-web-v1`) to HTTPS and loopback development pages. An extension-owned options page grants and revokes exact origins; web callers cannot edit grants or proxy arbitrary gateway methods. The SDK chunks PDF/image uploads, starts an isolated Codex session, and receives only that task's progress and terminal text/JSON result. These durable sessions have separate task workspaces, do not inherit the side panel's browser target or Tandix skill permissions, and are omitted from its saved session list. Local Agent tool approvals remain in the trusted side-panel UI. The native Codex adapter owns webpage task execution and atomically persists taskId → backend / agent-profile identity / sessionId → attempt / turnId, inputs, sequenced progress and results under `~/.tandix/web-tasks`. Webpage disconnects detach observers. Queries and reattachment never submit a model prompt; interrupted tasks require an idempotent explicit continuation in the original session, after history reconciliation. The extension retains a bridge lease for active work, and the SDK reconnects by task ID and event cursor. The task directory limits writes, not all filesystem reads; the local Agent's configuration still controls its tools.

Active webpage tasks hold bridge leases alongside side-panel ports. A closed panel therefore does not stop startup or the established connection for an active webpage task. Navigation and page disconnection detach the observer. Revocation cancels active work; execution timeouts and Agent interruptions retain the original context for explicit continuation. Reconnection reads existing state instead of submitting the original prompt again. See [the complete protocol, limits and SDK examples](web-api.md).

## Agent approvals

Browser read/action approvals remain enforced by the extension's background service worker. Local operations have a separate path: the dsh bridge forwards extension-owned `approval/request` waterfalls to the panel, then returns `allowed-once` or `rejected` to the same event ID; unanswered requests expire without a grant. The Codex app-server adapter forwards command, file-change, and permission approval requests through the same panel event UI and replies to the original JSON-RPC request. Codex supports one-request or session-scoped grants; dsh sandbox escalation is one-call only. Pending requests are replayed when the side panel reopens, and connection loss clears the UI rather than implying consent. Browser-wide access never grants filesystem or network privileges.

The DSH Teach Plugin will run in Harness, not inside the extension. It receives an exported or streamed recording, asks the model to propose parameters and assertions, and returns a TaskSpec draft. This keeps model credentials and model calls on the Harness side. The extension will show the draft in Clarify and will only persist an executable TaskSpec after explicit user confirmation.

The plugin interface should be versioned independently from the recording schema and include:

- recording/schema compatibility negotiation;
- compiler provenance and model metadata without credentials;
- structured clarification questions;
- diagnostics tied to recording event sequence numbers;
- a deterministic TaskSpec result or explicit compilation failure.

## Execution and repair boundary

The normal Run path will be deterministic: resolve parameters, validate allowed origins and preconditions, execute one typed step at a time, and evaluate assertions. Agent Repair is a separate fallback with a bounded page snapshot, failed step, observed/expected state, and an explicit repair budget. Repairs must produce a patch to the TaskSpec and pass replay validation; they must not become an unlogged free-form browser session.
