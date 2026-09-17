import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import {
  CliRenderEvents,
  type InputRenderable,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { fetchPage, normalizeInput, type PageData } from "./lib/web";
import { searchWeb, type SearchEngine } from "./lib/search";
import {
  attachAnswer,
  detectAnswerConfig,
  gatherSources,
  generateAnswer,
  generateAnswerStream,
} from "./lib/answer";
import { detectJevConfig, gateSources } from "./lib/jev";
import { loadAppConfig } from "./lib/config";
import { resolveTheme, syntaxStyleFromTheme } from "./lib/theme";

type FocusTarget = "url" | "page";

const WELCOME_URL = "welcome";
const WELCOME: PageData = {
  requestUrl: WELCOME_URL,
  finalUrl: WELCOME_URL,
  title: "Welcome to dowse",
  markdown: [
    "# dowse",
    "",
    "Search the web from your terminal — no GUI browser needed.",
    "",
    "## Search",
    "",
    "- Type anything and press `enter`: `terminal rss readers`, `bun vs node`.",
    "- `!b query` forces Bing · `!d query` forces DuckDuckGo.",
    "- `!g query` also searches (Google blocks bots, so it uses DuckDuckGo).",
    "- Results are numbered: type `3` + `enter` to open result `[3]`.",
    "- An AI answer with citations appears above results once `config.json`",
    "  holds a provider key (see README); `a` toggles it.",
    "",
    "## Open pages directly",
    "",
    "- Full URLs (`https://example.com`) and bare domains (`example.com`).",
    "- Inside a page, type any link number + `enter` to follow it.",
    "",
    "## Keys",
    "",
    "- `q` quit · `/` search bar · `esc` back to reading",
    "- `b` / `f` back / forward · `r` reload",
    "- `up` `down` `pgup` `pgdn` `home` `end` scroll while reading",
    "",
    "Try: `what is opentui`",
  ].join("\n"),
  links: [],
  contentType: "text/markdown",
  ms: 0,
};

/** Detect a pasted/remembered engine URL so history replays as a search. */
function asSearchUrl(raw: string): { engine: SearchEngine; query: string } | null {
  try {
    const u = new URL(raw);
    if (u.hostname === "html.duckduckgo.com" && u.pathname === "/html/") {
      const q = u.searchParams.get("q");
      if (q) return { engine: "ddg", query: q };
    }
    if (u.hostname === "lite.duckduckgo.com" && u.pathname === "/lite/") {
      const q = u.searchParams.get("q");
      if (q) return { engine: "ddg", query: q };
    }
    if (
      (u.hostname === "www.bing.com" || u.hostname === "bing.com") &&
      u.pathname === "/search" &&
      u.searchParams.get("format") === "rss"
    ) {
      const q = u.searchParams.get("q");
      if (q) return { engine: "bing", query: q };
    }
  } catch {
    // not a URL — not a search URL either
  }
  return null;
}

export function App() {
  const renderer = useRenderer();
  const [urlText, setUrlText] = useState("");
  const [focus, setFocus] = useState<FocusTarget>("url");
  const [page, setPage] = useState<PageData>(WELCOME);
  const [status, setStatus] = useState("Ready — type search terms and press enter.");
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("Loading");
  const [aiOn, setAiOn] = useState(true);
  const [jevOn, setJevOn] = useState(
    () => detectJevConfig(process.env, loadAppConfig().jev) !== null,
  );
  const [back, setBack] = useState<string[]>([]);
  const [fwd, setFwd] = useState<string[]>([]);
  const reqId = useRef(0);
  const streamAbort = useRef<AbortController | null>(null);
  const inputRef = useRef<InputRenderable | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [appConfig] = useState(loadAppConfig);
  const [termMode, setTermMode] = useState<"dark" | "light" | null>(() =>
    renderer.themeMode === "light" ? "light" : "dark",
  );
  const theme = useMemo(
    () => resolveTheme({ themeName: appConfig.theme, terminalMode: termMode }),
    [appConfig, termMode],
  );
  const syntax = useMemo(() => syntaxStyleFromTheme(theme), [theme]);

  useEffect(() => {
    const onMode = (mode: unknown) => {
      setTermMode(mode === "light" ? "light" : "dark");
    };
    renderer.on(CliRenderEvents.THEME_MODE, onMode);
    return () => {
      renderer.off(CliRenderEvents.THEME_MODE, onMode);
    };
  }, [renderer]);

  const load = useCallback(
    async (raw: string, opts?: { push?: boolean }) => {
      const trimmed = raw.trim();
      // Replay engine URLs from history as searches.
      const replay = asSearchUrl(trimmed);
      const norm = replay
        ? { ok: true as const, kind: "search" as const, query: replay.query, engine: replay.engine }
        : normalizeInput(trimmed, page);
      if (!norm.ok) {
        setStatus(norm.error);
        setFocus("url");
        return;
      }
      const id = ++reqId.current;
      streamAbort.current?.abort();
      streamAbort.current = null;
      const isSearch = norm.kind === "search";
      setLoading(true);
      setLoadingLabel(
        isSearch ? `Searching (${norm.engine === "bing" ? "Bing" : "DuckDuckGo"})` : "Loading",
      );
      setStatus(
        isSearch ? `Searching for “${norm.query}” …` : `Loading ${norm.url} …`,
      );
      setFocus("page");
      try {
        const data =
          norm.kind === "search"
            ? await searchWeb(norm.query, norm.engine)
            : await fetchPage(norm.url);
        if (id !== reqId.current) return; // superseded by a newer request
        if (
          opts?.push !== false &&
          page.finalUrl !== WELCOME_URL &&
          data.finalUrl !== page.finalUrl
        ) {
          setBack((b) => [...b, page.finalUrl]);
          setFwd([]);
        }
        // Keep the query editable after a search; show the URL after a page load.
        setUrlText(norm.kind === "search" ? norm.query : data.finalUrl);
        let note = norm.kind === "search" && norm.note ? ` · ${norm.note}` : "";
        // Show results immediately, then stream the AI summary on top.
        setPage(data);
        setLoading(false);
        setStatus(
          `${data.title} · ${data.links.length} links · ${data.ms}ms${note}`,
        );
        // Answer-engine summary on top of search results.
        if (norm.kind === "search" && aiOn && data.links.length > 0) {
          // Config file is re-read per search, so adding a key needs no restart.
          const cfg = detectAnswerConfig(process.env, loadAppConfig().ai);
          if (!cfg) {
            setStatus(
              `${data.title} · ${data.links.length} links · ${data.ms}ms${note} · AI off (put a key in config.json)`,
            );
          } else {
            const ctrl = new AbortController();
            streamAbort.current = ctrl;
            try {
              setStatus(
                `${data.title} · ${data.links.length} links · gathering sources…${note}`,
              );
              const sources = await gatherSources(
                data.links.map((l) => ({ title: l.text, url: l.url })),
              );
              if (id !== reqId.current) return;
              if (sources.length === 0) {
                setStatus(
                  `${data.title} · ${data.links.length} links · ${data.ms}ms${note} · AI skipped (no readable sources)`,
                );
                return;
              }
              // Opt-in Jev rerank: filter to the most relevant sources before
              // summarizing. Never blocks the answer — falls back on failure.
              let answerSources = sources;
              let jevNote = "";
              const jevCfg = jevOn
                ? detectJevConfig(process.env, loadAppConfig().jev)
                : null;
              if (jevCfg && sources.length > 1) {
                setStatus(`${data.title} · reranking sources (Jev)…${note}`);
                const gated = await gateSources(norm.query, sources, jevCfg, ctrl.signal);
                if (id !== reqId.current) return;
                answerSources = gated.sources;
                if (!gated.skipped) jevNote = ` · Jev ${gated.kept}/${gated.total}`;
              }
              setStatus(`${data.title} · summarizing…${note}`);
              const onToken = (partial: string) => {
                if (id !== reqId.current) return;
                setPage({
                  ...data,
                  markdown: attachAnswer(data.markdown, `${partial} ▍`, cfg.label),
                });
              };
              let answer: string;
              try {
                answer = await generateAnswerStream(
                  norm.query,
                  answerSources,
                  cfg,
                  onToken,
                  ctrl.signal,
                );
              } catch (e) {
                if (e instanceof DOMException && e.name === "AbortError") return;
                if (e instanceof Error && e.message === "stream-unavailable") {
                  answer = await generateAnswer(norm.query, answerSources, cfg);
                } else {
                  throw e;
                }
              }
              if (id !== reqId.current) return;
              setPage({
                ...data,
                markdown: attachAnswer(data.markdown, answer!, cfg.label),
              });
              setStatus(
                `${data.title} · ${data.links.length} links · ${data.ms}ms${note} · AI ✓${jevNote}`,
              );
            } catch (e) {
              if (id !== reqId.current) return;
              if (e instanceof DOMException && e.name === "AbortError") return;
              setStatus(
                `${data.title} · ${data.links.length} links · ${data.ms}ms${note} · AI failed: ${e instanceof Error ? e.message : String(e)}`,
              );
            } finally {
              if (streamAbort.current === ctrl) streamAbort.current = null;
            }
          }
        }
      } catch (e) {
        if (id !== reqId.current) return;
        setStatus(e instanceof Error ? e.message : String(e));
        setFocus("url");
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [page, aiOn, jevOn],
  );

  const goBack = useCallback(() => {
    if (back.length === 0) {
      setStatus("No back history.");
      return;
    }
    const prev = back[back.length - 1];
    setBack((b) => b.slice(0, -1));
    setFwd((f) => (page.finalUrl === WELCOME_URL ? f : [...f, page.finalUrl]));
    void load(prev, { push: false });
  }, [back, fwd, load, page]);

  const goFwd = useCallback(() => {
    if (fwd.length === 0) {
      setStatus("No forward history.");
      return;
    }
    const next = fwd[fwd.length - 1];
    setFwd((f) => f.slice(0, -1));
    setBack((b) => (page.finalUrl === WELCOME_URL ? b : [...b, page.finalUrl]));
    void load(next, { push: false });
  }, [fwd, load, page]);

  const reload = useCallback(() => {
    if (page.finalUrl === WELCOME_URL) {
      setStatus("Nothing to reload yet — navigate somewhere first.");
      return;
    }
    void load(page.finalUrl, { push: false });
  }, [load, page]);

  useKeyboard((key) => {
    // Global shortcuts run before the focused renderable sees the key, so
    // read live focus here: while the URL bar really has focus it owns every
    // key, and shortcuts must stay silent so typing never triggers actions.
    // (Cached focus state is unreliable — typing emits spurious focus events.)
    const typing =
      inputRef.current !== null &&
      renderer.currentFocusedRenderable === inputRef.current;
    if (typing) {
      if (key.name === "escape") {
        inputRef.current?.blur();
        setFocus("page");
        scrollRef.current?.focus();
      }
      return;
    }
    if (key.name === "q") {
      renderer.destroy();
      return;
    }
    if ((key.ctrl && key.name === "l") || key.name === "/") {
      setFocus("url");
      inputRef.current?.focus();
      return;
    }
    switch (key.name) {
      case "b":
        goBack();
        break;
      case "f":
        goFwd();
        break;
      case "r":
        reload();
        break;
      case "a": {
        const next = !aiOn;
        setAiOn(next);
        setStatus(next ? "AI answers on." : "AI answers off.");
        break;
      }
      case "j": {
        const next = !jevOn;
        if (next && !detectJevConfig(process.env, loadAppConfig().jev)) {
          setStatus("Jev off (opt-in: set TYPESAFE_API_KEY + JEV_ENABLED=1).");
          break;
        }
        setJevOn(next);
        setStatus(next ? "Jev rerank on." : "Jev rerank off.");
        break;
      }
    }
  });

  const content = loading ? `# ${loadingLabel}…` : page.markdown;

  return (
    <box
      style={{
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: theme.colors.background,
      }}
    >
      <box
        title=" dowse "
        style={{
          border: true,
          borderStyle: "rounded",
          borderColor: theme.colors.border,
          flexDirection: "row",
          paddingX: 1,
          height: 3,
          width: "100%",
        }}
      >
        <text fg={theme.colors.accent}>Find </text>
        <input
          ref={inputRef}
          id="url-input"
          focused={focus === "url"}
          value={urlText}
          onInput={setUrlText}
          onSubmit={(v) => void load(typeof v === "string" ? v : urlText)}
          placeholder="search terms · URL · link # · !b !d !g"
          style={{ flexGrow: 1, focusedBackgroundColor: theme.colors.selection }}
        />
      </box>

      <box style={{ paddingX: 1, height: 1, width: "100%" }}>
        <text fg={/^(Failed|HTTP|Timed|Search engine|No back|No forward|Nothing|Only|No link)/.test(status) ? theme.colors.error : theme.colors.muted}>
          {`◀${back.length} ▶${fwd.length} · ${status}`}
        </text>
      </box>

      <scrollbox
        ref={scrollRef}
        id="reader"
        focused={focus === "page"}
        style={{ flexGrow: 1, width: "100%", paddingX: 2 }}
      >
        <markdown content={content} syntaxStyle={syntax} />
      </scrollbox>

      <box style={{ paddingX: 1, height: 1, width: "100%" }}>
        <text fg={theme.colors.muted}>
          q quit · / find · esc read · b/f back/fwd · r reload · a AI{aiOn ? "✓" : "✗"} · j Jev{jevOn ? "✓" : "✗"} · N+enter opens [N]
        </text>
      </box>
    </box>
  );
}
