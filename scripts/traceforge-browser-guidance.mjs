/** Short MCP initialization guidance shared with the Tandix Codex session. */
export const TANDIX_BROWSER_INSTRUCTIONS = [
  'This MCP server controls the user\'s Tandix tab; other browser connectors have separate tab inventories.',
  'For Tandix UI work, use a current handoff snapshot or call browser_snapshot. If the target tab differs, use browser_list_tabs and browser_follow_tab.',
  'Check a Tandix browser tool before reporting the tab unavailable, and report its actual result.',
  'Preserve the user\'s chosen thread or document. A draft-only request never authorizes sending.',
].join(' ')
