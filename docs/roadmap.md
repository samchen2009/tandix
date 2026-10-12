# TraceForge roadmap

## Phase 1 — runnable recording skeleton

Status: implemented in this branch.

- Preserve existing dsh-browser Chat and browser control.
- Add versioned recording and TaskSpec contracts.
- Add the Teach state machine and module boundaries.
- Capture click, input/change, select, submit, keydown, navigation, and tab information.
- Redact sensitive values in the content script before messaging.
- Persist metadata and ordered events in IndexedDB across MV3 worker suspension.
- Export recording JSON and JSONL.
- Add Chat / Teach / Clarify / Run navigation, live red recording state, and stopped summaries.
- Cover schema validation, state restoration, and content-side redaction with tests.

Phase-one limits are deliberate: no arbitrary-site API reverse engineering, no TaskSpec compiler, no deterministic runner, no agent repair, and no model key in the extension.

## Phase 2 — DSH Teach Plugin and clarification

- Add a Harness-side Teach Plugin that consumes `traceforge.recording/v1` and emits a TaskSpec draft.
- Stream recordings to Harness through a versioned bridge method while retaining offline export/import.
- Infer candidate parameters from repeated inputs, page context, and user intent; represent secrets only as Harness credential references.
- Generate selectors with ranked fallbacks and explain unstable targets.
- Propose preconditions and success assertions from observed before/after state.
- Render structured clarification questions in the Clarify workspace.
- Require explicit confirmation of parameters, allowed origins, destructive actions, and assertions.
- Store compiler diagnostics and provenance alongside the TaskSpec.

Exit criterion: a user can record a supported flow, resolve all compiler questions, and obtain a schema-valid TaskSpec without manually editing JSON.

## Phase 3 — deterministic execution and verification

- Implement a runner for typed TaskSpec steps using the existing browser action layer.
- Add parameter binding, Harness-side secret resolution, origin policy enforcement, step timeouts, and cancellation.
- Resolve targets through deterministic selector/role/name fallbacks; do not ask the model on the happy path.
- Capture compact evidence for every step and evaluate preconditions/success assertions.
- Add dry run, step-through, and replay against a fixture site.
- Persist run records separately from teaching recordings.

Exit criterion: fixture tasks replay repeatedly with deterministic results and actionable assertion failures.

## Phase 4 — API/CDP-assisted recording

- Add opt-in Chrome DevTools Protocol capture for network request/response metadata and richer navigation signals.
- Correlate user actions with fetch/XHR requests without storing authentication headers, cookies, raw bodies, or secrets by default.
- Detect stable first-party API operations as compiler hints; never begin with arbitrary website API reverse engineering.
- Add explicit capture scopes, per-origin consent, payload size ceilings, and retention controls.
- Allow TaskSpec steps to choose DOM execution or an approved API adapter when semantics and authentication boundaries are verified.

Exit criterion: supported flows can use recorded API evidence to improve reliability while preserving the browser session and privacy boundary.

## Phase 5 — bounded Agent Repair

- Invoke a Harness agent only after deterministic execution or verification fails.
- Provide the failed step, bounded current snapshot, prior evidence, expected assertion, and approved origin/operation scope.
- Enforce a repair budget for time, model turns, browser actions, and origin changes.
- Require repair output to be a reviewable TaskSpec patch with confidence and evidence.
- Replay the patched segment and regression-test previous successful steps before accepting it.
- Keep audit logs and allow users to reject or pin repairs.

Exit criterion: recoverable UI drift can produce a validated, reviewable task update without turning every run into open-ended agent browsing.

## Cross-cutting work

- Schema migrations and backward compatibility fixtures.
- Recording/run retention, deletion, import, and export controls.
- Accessibility-first target descriptions and internationalized UI copy.
- Firefox parity and browser-specific lifecycle tests.
- Benchmark corpus covering SPA navigation, iframes, tab changes, protected pages, and secrets.
- Threat modeling for prompt injection, compromised pages, export tampering, and malicious TaskSpecs.
