# dowse

**Dowse** (rhymes with "house"): to search for hidden water with a divining
rod. This is a terminal web browser that dowses the web for answers —
search and read pages without leaving your terminal.
Built with [OpenTUI](https://opentui.com) (`@opentui/react`) — pages render as a
reader view with numbered links you can follow by number.

## What it does (so far)

* **Search-first bar** — type anything, get clean numbered results (title + snippet)
  from DuckDuckGo (default) or Bing (`!b query`). `!d` forces DuckDuckGo,
  `!g` maps to DuckDuckGo with a note (Google blocks terminal clients).
* **Reader view** — pages are fetched and converted to markdown
  (headings, lists, code, tables stripped of chrome/scripts).
* **Follow links by number** — every link becomes `[N]`; type `N` + enter
  (works for search results and in-page links).
* **AI answers** — every search gets a cited summary on top (RAG over the top
  5 results), like Google's AI Overviews. Needs a provider key (below);
  gracefully degrades to plain results without one. `a` toggles per session.
* **History** — back/forward stacks that replay searches as searches.
* **Direct URLs** — full URLs, bare domains (`example.com`), `host:port`
  (`localhost:3000`); `text/*` renders as code, binaries show an info page.

## Stack

* Runtime: Node.js 26.9 via [mise](https://mise.jdx.dev) (`mise.toml`)
* Package manager: pnpm 11.5.1
* UI: `@opentui/core` + `@opentui/react` 0.5.11, React 19, `web-tree-sitter`
* Runner/typecheck: `tsx`, `typescript`

## Setup

```sh
mise install
mise exec -- pnpm install
```

`esbuild` is pre-approved in `pnpm-workspace.yaml` (`allowBuilds`) so
`tsx` works — nothing else is approved.

## Run

```sh
mise exec -- pnpm dev     # or: pnpm dev (if mise is active in your shell)
mise exec -- pnpm typecheck
```

OpenTUI needs Node ≥ 26.4 **with `--experimental-ffi`** — the `dev`/`start`
scripts pass the flag directly on the command line (`node --experimental-ffi
./node_modules/tsx/dist/cli.mjs …`) because Node rejects it in `NODE_OPTIONS`.

## Install (binary)

Grab `dowse-linux-x64` from the
[latest release](https://github.com/NjengaFelix/dowse/releases/latest)
— a single self-contained executable for glibc Linux x64, no runtime needed:

```sh
chmod +x dowse-linux-x64
./dowse-linux-x64
```

To build it yourself (Bun is used only as the bundler/compiler):

```sh
mise exec -- pnpm build:exe   # → dist/dowse-linux-x64
```

## Usage

| Input | Action |
|---|---|
| `terminal rss readers` | DuckDuckGo search |
| `!b terminal rss readers` | Bing search |
| `!d …` / `!g …` | DuckDuckGo (`!g` notes Google is bot-blocked) |
| `example.com`, `https://…`, `localhost:3000` | Open page directly |
| `3` | Open link/result `[3]` on the current page |

| Key | Action |
|---|---|
| `q` | Quit |
| `/` or `ctrl+l` | Focus search bar |
| `esc` | Back to reading |
| `b` / `f` | Back / forward |
| `r` | Reload |
| `a` | Toggle AI answers |
| `↑` `↓` `pgup` `pgdn` `home` `end` | Scroll while reading |

## AI answers (answer engine)

Each search fetches the top 5 results, distills them to text, and asks an LLM
for a short cited summary shown above the results — citations `[N]` match the
Links section, so they're followable like any other link.

Configure with `config.json` (git-ignored — never commit it) or environment
variables. Layered like opencode, lowest precedence first:

1. `~/.config/opentui-browser/config.json` (respects `XDG_CONFIG_HOME`) —
   your keys and defaults, shared across checkouts
2. `./config.json` — project-local overrides, merged per-field
3. Environment — explicit `AI_PROVIDER` first, then provider keys
   (`ANTHROPIC` → `OPENAI` → `OPENROUTER` → `GEMINI`), then Ollama hosts.
   `AI_MODEL`/`AI_BASE_URL` always beat file values.

```jsonc
// ~/.config/opentui-browser/config.json (project ./config.json overrides it)
{
  "theme": "system",               // system | dark | light | tokyonight | catppuccin | gruvbox | nord | <custom>
  "ai": {
    "provider": "gemini",          // anthropic | openai | openrouter | gemini | ollama
    "apiKey": "AIza…",             // your key (aistudio.google.com → Get API Key)
    "model": "gemini-2.5-flash"    // optional override
  }
}
```

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (default model `claude-haiku-4-5`) |
| `OPENAI_API_KEY` | OpenAI (default `gpt-4o-mini`) |
| `OPENROUTER_API_KEY` | OpenRouter (default `openai/gpt-4o-mini`) |
| `GEMINI_API_KEY` | Gemini via OpenAI-compatible endpoint (default `gemini-2.5-flash`) |
| `AI_PROVIDER=anthropic\|openai` | Force provider (key from `AI_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) |
| `AI_MODEL` | Override the model |
| `AI_BASE_URL` | Override the endpoint (e.g. local Ollama `http://localhost:11434/v1`) |

```sh
# paste your key into ~/.config/opentui-browser/config.json, then:
mise exec -- pnpm dev
```

Without any key the browser works normally and notes "AI off" in the status
line. Summary failures never break results — the error is noted, results stay.

## Theming (opencode-style, Omarchy-aware)

`"theme"` in config.json selects the look. Default `"system"` adapts:

* **On Omarchy**, the staged theme (`.../omarchy/current/theme/colors.toml` —
  whatever `omarchy-theme-set` last applied) is read directly, so the browser
  matches Tokyo Night / Catppuccin / Gruvbox / … automatically, including
  after a theme switch (restart the browser to pick it up).
* **Elsewhere**, the terminal's dark/light mode picks the `dark`/`light` theme.

| Value | Effect |
|---|---|
| `system` (default) | Omarchy colors if present, else terminal dark/light |
| `dark`, `light`, `tokyonight`, `catppuccin`, `gruvbox`, `nord` | Built-in palettes |
| any other name | Custom `*.json` theme (see below), else falls back to `dark` |

**Custom themes** — drop `<name>.json` in `~/.config/opentui-browser/themes/`
(respects `XDG_CONFIG_HOME`) or `./themes/`, then `"theme": "<name>"`.
Partial files merge over the `dark` built-in; `"none"` means transparent
(terminal default shows through):

```jsonc
// ~/.config/opentui-browser/themes/my-theme.json
{
  "mode": "dark",
  "background": "#101010",
  "foreground": "#e6edf3",
  "muted": "#8b949e",
  "border": "#30363d",
  "accent": "#58a6ff",   // headings, URL label
  "link": "#58a6ff",
  "code": "#a5d6ff",
  "listMarker": "#ff7b72",
  "error": "#ff7b72",
  "success": "#3fb950",
  "warning": "#d29922",
  "selection": "#264f78" // focused input background
}
```

The theme also drives markdown highlighting, and follows live terminal
dark/light switches via the renderer's `theme_mode` event (in `system` mode
without Omarchy).

## Project structure

```
src/
  index.tsx            # entry: createCliRenderer + createRoot(<App />)
  App.tsx              # layout, focus modes, history, keybindings
  lib/
    web.ts             # input normalization, fetchPage/fetchText (timeout, UA)
    search.ts          # DDG-HTML + Bing-RSS engines → followable result pages
    answer.ts          # provider detection, source gathering, cited summaries (RAG)
    config.ts          # layered config.json loader (never throws)
    theme.ts           # tokens, built-ins, Omarchy reader, custom themes, resolver
    html-to-markdown.ts# reader-mode HTML → markdown + numbered link extraction
```

## Implementation notes

* Search history entries replay through the same router, so back/forward and
  reload on a results page re-run the search instead of showing raw HTML.
* In-flight requests carry an ID — a newer navigation supersedes older ones.
* TSX files import `React` explicitly: tsx compiles JSX in classic mode here,
  so the automatic runtime alone fails with `React is not defined`.
* `SyntaxStyle.fromStyles` touches native code at import time, so any import
  of the UI requires the FFI-capable runtime (Node 26.4+).

## Ideas (not built yet)

Tabs · persistent history/bookmarks · image support · vim-style `j`/`k`
scrolling · more engines · result caching.
