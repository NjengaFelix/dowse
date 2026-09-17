# dowse roadmap

Prioritized UI/UX work to make dowse a daily Google replacement.
Each item below is tracked as a GitHub issue.

## 1. Streaming AI answers
**Problem:** searches stare at "Summarizing…" for 10–20s (fetch 5 pages, then
wait for the full answer).
**Change:** stream summary tokens into the Answer section as they arrive
(SSE/`data:` chunks from Anthropic + OpenAI-compatible endpoints), then
finalize. Keep the non-streaming path as fallback.
**Notes:** needs an incremental markdown update path; citations may arrive
late — render what exists, settle at the end.

## 2. Link cursor
**Problem:** typing `3`+enter works but is slow for triaging 10 results.
**Change:** arrow-key (or `j`/`k`) cursor over results/links with enter-to-open;
numbers stay as a fallback. Visible highlight on the current link.
**Notes:** cursor state lives in App; must not fight scrollbox key handling —
only active in reading mode, never while the input is focused.

## 3. Reading position + find-in-page
**Problem:** long pages are disorienting, no way to locate text.
**Change:** `line N/M` + `%` indicator in the status bar; `n` jumps between
headings; a find-in-page prompt (`Ctrl+F` style) with match jumping.
**Notes:** derive position from scrollbox state; headings come from the
markdown already rendered.

## 4. Tabs
**Problem:** opening a result destroys the results list; `b`-back re-reads it.
**Change:** 2–3+ tabs (`t` new, `x` close, `1/2/3` switch), each with its own
page + history + scroll position. Tab strip in the header.
**Notes:** biggest build here — lift per-tab state (`page`, `back`, `fwd`,
`urlText`) into a tab object; input/history logic becomes tab-scoped.

## 5. Copy out
**Problem:** findings are trapped in the terminal.
**Change:** `y` yanks the current URL, `Y` yanks the AI answer (OpenTUI has
clipboard built in — OSC 52 + host clipboard).
**Notes:** confirm in the status line ("yanked N chars"); handle headless/SSH
where clipboard is unavailable.

## 6. Polish layer
- `?` help overlay listing all keys
- `t` theme cycling (built-ins; persists to config.json)
- spinner/activity indicator during loads
- persistent history + bookmarks across restarts (local JSON file)
