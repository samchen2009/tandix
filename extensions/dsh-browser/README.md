# Tandix Extension (Chrome and Firefox MV3)

English | [中文](README.zh.md)

**Turn browser traces into reliable agent tasks.** The extension retains the full dsh-browser chat/control surface and adds Teach, Clarify, and Run workspaces. Phase one records privacy-safe DOM, navigation, and tab events into IndexedDB and exports versioned JSON or JSONL.

The **browser-operation end** of dsh: the model reads and operates the browser page you have open — extract content, click elements, fill forms, scroll, and navigate, all in the real page with your login state preserved. The side panel is the conversation entry.

**Page reading and image attachments**: browser pages are normally rendered as structured text (a numbered interactive-element inventory). For canvas-based tables and other visual pages, `browser_screenshot` captures the visible controlled tab. Separately, compatible agent hosts advertise multimodal image limits so the side panel can accept image attachments and render their durable history references.

## What the model can do

| Capability | Action | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Title/URL/main text/numbered inventory/form fields (sensitive values masked); `delta: true` returns only changes |
| Click element | `browser_click` | Click by inventory number (links/buttons/checkboxes…), React/Vue compatible |
| Fill forms | `browser_type` | Type text; `replace` clears first |
| Keys | `browser_press` | Enter/Tab/Escape/arrows etc. |
| Scroll | `browser_scroll` | Viewport scrolling (up/down/top/bottom) |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, or open a URL in a new tab and follow it |
| List tabs | `browser_list_tabs` | List accessible tabs with stable IDs, titles, URLs, and active/controlled state |
| Follow tab | `browser_follow_tab` | Bind later browser tools to a listed tab without activating it |
| Close tab | `browser_close_tab` | Close a listed tab |
| Read region | `browser_get_text` | Lazy-loaded content / partial text |
| Wait | `browser_wait` | Page load and render-settle detection |
| Chat with images | `session.prompt` / `session.attachment` | Host-gated image selection, image-only sends, and durable history previews |
| Quote what you highlight | side panel composer | The text you select in the page becomes a quote in the composer and rides along with your next message |

## Architecture

```
side panel (React) ◄─port─► background SW/event page ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION, DSH_SELECTION_WATCH)
                                 ▲ DSH_SELECTION
                                 ▼
                        content script (snapshot/actions/privacy/selection)
```

- **background** (`src/background/`): bridge connection (token auth + exponential-backoff reconnect + keepalive), gateway RPC client, and **fail-closed tool dispatch to a user-controlled tab**.
- **content script** (`src/content/`): text-only snapshot (readability main text + numbered interactive inventory + form fields), **stable element numbers** (`data-dsh-el`), delta changes, click/type/press/scroll/navigate actions, sensitive-field masking, and a debounced selection watcher that stays disarmed until a side panel is open and page sharing is not `off`.
- **panel** (`src/panel/`): React conversation UI (resumable session/history/live events/settings); host-advertised image limits gate image selection and preflight checks, durable attachments render through session-authorized reads, messages render as sanitized Markdown, `ask_user_question` requests render as answerable cards, manual tab switches render a control-handoff strip, an active turn exposes a standard stop control, and a highlighted page passage renders as a removable quote that the next prompt carries inside the untrusted-content boundary.
- **Protocol**: `protocol.ts` in the `@yuxianglin/dsh-bridge-browser` workspace package is the single source of truth, shared by both ends through the package's source export.

## Build

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Run these commands from the repository root. Chrome outputs to `extensions/dsh-browser/dist/`; Firefox outputs to `extensions/dsh-browser/dist-firefox/`.

## Install and use

The recommended zero-configuration command does not require Git or a local clone:

1. **Build and install the extension**:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/samchen2009/tandix/refs/heads/main/scripts/install/source-unix.sh | bash
   ```

   On Windows, run this in PowerShell instead:

   ```powershell
   $s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/samchen2009/tandix/refs/heads/main/scripts/install/source-windows.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
   ```

   The script downloads a managed workspace to `~/.dsh/dsh-browser`, builds the bridge plugin, registers its official bundle in the local dsh `web` profile, builds the extension, copies the output to the stable directory `~/.dsh/browser-extension`, and opens `chrome://extensions`. Enable Developer mode, choose Load unpacked, and select the extension directory. Running the command again updates the managed installation.

   A cloned checkout uses the same installer without downloading or overwriting source files:

   ```sh
   git clone https://github.com/samchen2009/tandix.git
   cd dsh-browser
   ./scripts/install/source-unix.sh
   ```

   Windows checkouts run `.\scripts\install\source-windows.ps1` instead. Paths containing spaces are supported: the installer uses a profile-local directory junction instead of putting the absolute checkout path in pnpm's link spec.

2. **Start dsh with the bridge plugin mounted**. Use either the workspace-pinned runtime:

   ```sh
   cd ~/.dsh/dsh-browser && pnpm start
   ```

   From a clone, run `pnpm start` in the repository root instead.

   Or use the exact supported public runtime:

   ```sh
   npx @deepseek-ai/dsh@0.1.5-rc.2 web
   ```

   Both commands load the same bundle from the local `web` profile. Port 3080 is used by default; append `--port <port>` when it is occupied.

   **DSH Desktop users**: the Desktop app assigns a random local Web port by default (`dsh-desktop.port: 0`), so port-based auto-discovery cannot predict it. Pin the port to `43189` in Desktop settings (see the [deepseek-harness-desktop user guide](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/docs/user-guide.en.md)); auto-discovery covers that port. Alternatively, enter `http://127.0.0.1:<port>` manually in the side-panel settings.

   Loading or reloading the extension is passive: it does not probe local ports or open a WebSocket until the side panel is opened. A healthy connection established by the user may remain available for background approvals after the panel closes, but it will not reconnect without an open panel if it drops or another browser replaces it.

3. **Use it**: open a normal `http://` or `https://` page and click the Tandix icon. Both builds auto-discover local dsh. Chrome loopback connections need no address or token; Firefox must be given the token from `~/.dsh/ext-bridge-token` because a `moz-extension://` UUID is not an add-on identity. Chat directly or click "Read page" first.

   On macOS Chrome, optional **on-demand startup** removes the need to run `pnpm start` manually. Load the extension in Chrome first, run `pnpm native:install` from the repository root, then reload the extension at `chrome://extensions` and accept its new native-messaging permission. The installer allows only the currently loaded Tandix extension ID and does not add a login item. Click the Agent control below the composer to choose **Automatic**, **Codex**, **Cursor**, **WorkBuddy**, or **dsh**. The adjacent model control shows configuration reported by the current runtime, with defaults and saved values labelled separately. Automatic tries Codex, Cursor, WorkBuddy, then dsh, using the first available connection; an explicit choice never falls back to another Agent. Codex uses the Tandix chat without a separately configured model, Base URL, or OpenAI API key; the Codex desktop window need not remain open. dsh model-provider configuration remains available in Settings. Switching Agents reconnects the bridge and starts a fresh chat session; prior sessions remain with their original Agent. The companion stops only Agent processes it started after all panels have been closed for ten minutes. An independently started dsh is never stopped by the companion. dsh startup diagnostics are in `~/.dsh/traceforge-native-host/dsh.log`.

   The Settings "Sandbox directory" field applies only to the local native companion. Leave it empty for the defaults, or choose a specific local folder. Codex adds it to the `workspaceWrite` writable roots; dsh uses it as the workspace root for newly created conversations. Existing dsh sessions retain their original workspace. A separately started dsh cannot be retrofitted with this setting: stop it before reconnecting. The companion creates a missing selected directory, but macOS privacy permissions still apply. After changing the native host source, run `pnpm native:install` again and reload the extension.

Pages that were already open before extension installation or reload are instrumented automatically on the first action, so they do not require a manual refresh. Browser-internal and protected pages such as `chrome://` and the Chrome Web Store expose only tab metadata and browser-level HTTP(S) navigation, back, forward, and reload; their DOM cannot be read or operated.

Chat tool cards can be expanded to inspect the tool name, arguments or local bash command, and the returned status/output preview. Browser tools run through the extension in the controlled tab; `bash` is a separate local dsh tool, not a browser operation. Typed page values and obvious credential arguments are masked in these details.

For extension-only development, load `extensions/dsh-browser/dist/` from `chrome://extensions`, or run `build:firefox` and load `extensions/dsh-browser/dist-firefox/manifest.json` from `about:debugging#/runtime/this-firefox`. Rebuild and reload after code changes.

## Why browser operation stays text-only

- **Snapshot as the view**: the model's entire view of the page is structured text (title/URL/main/numbered elements/forms), budgeted at 32k chars by default (plugin-configurable, negotiated to the extension via `hello.ok`).
- **Page text is untrusted input**: snapshots and targeted text reads are enclosed in a fresh nonce-bound trust marker and explicitly tell the model never to treat page-authored commands as instructions. This is defense in depth; extension-side action approval is the enforcement boundary.
- **Stable numbering**: element numbers persist across snapshots (WeakMap + `data-dsh-el`), so the model can say "click 7"; a large page change explicitly reports "numbers reindexed".
- **Delta mode**: `browser_snapshot({delta:true})` returns only changed element numbers, saving tokens.
- **Privacy**: password/credit-card values always render as `••••` and never leave the page; accessible names never use a sensitive field's current value.
- **Tab affinity**: prompt submission binds the active tab before the model starts working; a direct browser-tool call also performs the initial bind when needed. A manual tab/window switch pauses later tools and asks whether the assistant should stay on the original tab or follow the newly visible one. Staying permits explicit background operation without changing the user's visible tab; following resets page-reference state. A closed controlled tab fails closed until the user selects the current page, and a switch withdraws any open action approval.
- **Proportional approval**: the default `auto` mode lets the model read the controlled tab without an extra prompt; `ask` restores per-read confirmation and `off` blocks reads. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`, which remains reversible in Settings. State-changing tools still fail closed and show their exact origin plus a redacted action summary. The user may deny, allow once, or trust one origin for the current side-panel session; temporary trust clears when the last panel closes or the service worker restarts. Permanent trust is managed explicitly in Settings. If the panel is closed, an approval remains pending for up to 60 seconds and, when enabled, a system notification opens the panel for review. The panel restores the requesting session before showing a session-scoped approval. Caller cancellation or bridge timeout withdraws any open approval before an action can run.
- **Unrestricted control is explicit**: **Allow unrestricted browser control** becomes active only after the setting is saved successfully, then lets page reads, page actions, and tab list/follow/close operations run without confirmation. Calls capture their access mode when received, so enabling unrestricted control never retroactively elevates an existing restricted call. Disabling it takes effect immediately, cancels calls that have not dispatched an action, waits for already-dispatched browser operations to settle, and only then saves the restrictive setting. A rapid re-enable remains restricted until that revocation finishes, and concurrent saves persist in request order. Protected-page DOM content remains inaccessible.
- **Conversation continuity**: reopening the panel resumes the most recently active browser conversation by default, falling back to the latest non-empty durable session before creating a new one. This can be disabled in Settings.

## Permissions

Chrome uses `sidePanel`; Firefox uses `sidebar_action`. Both request `storage` (settings and recent-session continuity), `notifications` (optional reminders for approvals received while the panel is closed), `tabs` + `activeTab` + `scripting` (observe tab changes and inject/message the explicitly controlled tab, including lazy recovery for pages opened before install), `webNavigation` (enumerate and bind messages to that tab's frame documents), `alarms` (background keepalive), and `<all_urls>` (browser screenshot authorization; content scripts still match only HTTP/HTTPS pages). Firefox's AMO manifest declares the browsing activity, website content/activity, and personal communications that the add-on sends to the configured dsh/model service. The extension never changes the visible tab or silently follows a manual switch; background operation happens only after the user chooses to stay on the original tab.

## Known limitations

- Only one extension connection at a time. An unopened browser profile never claims it; if another open panel replaces a live connection, the replaced client yields instead of starting a reconnect fight.
- Tab affinity is global to that extension connection rather than per chat session.
- Accessible cross-origin iframes are snapshotted and operated with stable `(frame, index)` addresses. Restricted or short-lived frames are reported as unavailable without failing the whole page snapshot.
- Captcha/image-only controls cannot be handled — the tool result reports "elements with no accessible name" and asks the user to complete that step manually.
- No automatic token rotation.
- Synthetic `browser_press` events do not trigger browser-native default actions such as Tab focus movement, arrow-key scrolling, or Enter activation; use manual input when a workflow depends on those defaults.
- `browser_wait` considers page load plus a fixed quiet window, but does not observe continuously changing DOM state; a live-updating SPA may be reported as stable.

### Screenshot access

[Chrome requires `<all_urls>` host permission or a temporary `activeTab` grant for `tabs.captureVisibleTab`](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab); separate `http://*/*` and `https://*/*` declarations do not satisfy its `<all_urls>` check. Both extension manifests declare `<all_urls>` so screenshot access does not depend on clicking the toolbar icon again after each tab handoff. Existing page-sharing and controlled-tab checks still apply.

The Full access setting skips Tandix approval prompts; browser site-access restrictions still apply. If the browser denies capture, keep the target page active and click the Tandix toolbar icon, then retry. After an extension update, reload Tandix and review its browser site-access setting. Canvas-rendered table cells may be absent from text snapshots, and reading an ordinary webpage image cannot replace a screenshot of that table.
