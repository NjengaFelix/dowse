import { htmlToMarkdown, type PageLink } from "./html-to-markdown";
import type { SearchEngine } from "./search";

export interface PageData {
  /** URL as requested (after normalization). */
  requestUrl: string;
  /** URL after redirects. */
  finalUrl: string;
  title: string;
  markdown: string;
  links: PageLink[];
  contentType: string;
  /** Fetch + convert time in ms. */
  ms: number;
}

export type NormalizedInput =
  | { ok: true; kind: "url"; url: string }
  | { ok: true; kind: "search"; query: string; engine: SearchEngine; note?: string }
  | { ok: false; error: string };

export const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 1_500_000;

export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 (compatible; dowse/0.1; terminal reader)";

/**
 * Interpret the search/URL bar text. Handles:
 * - `N` (a number) -> follow the Nth link on the current page
 * - `!b query` -> Bing search, `!d query` -> DuckDuckGo search,
 *   `!g query` -> DuckDuckGo (Google blocks terminal clients)
 * - full http(s) URLs
 * - bare domains / hosts (https:// is prepended)
 * - anything else -> web search (default: DuckDuckGo)
 */
export function normalizeInput(
  raw: string,
  page: PageData | null,
): NormalizedInput {
  const text = raw.trim();
  if (!text) {
    return { ok: false, error: "Type search terms, a URL, or a link number." };
  }

  if (/^\d+$/.test(text) && page) {
    const n = parseInt(text, 10);
    const link = page.links[n - 1];
    if (!link) {
      return {
        ok: false,
        error: `No link [${n}] on this page (1–${page.links.length}).`,
      };
    }
    return { ok: true, kind: "url", url: link.url };
  }

  const bang = text.match(/^!(b|bing|d|ddg|g|google)\s+(.+)$/i);
  if (bang) {
    const flag = bang[1].toLowerCase();
    const query = bang[2].trim();
    if (!query) return { ok: false, error: "Search terms missing after !prefix." };
    if (flag === "b" || flag === "bing") {
      return { ok: true, kind: "search", query, engine: "bing" };
    }
    if (flag === "g" || flag === "google") {
      return {
        ok: true,
        kind: "search",
        query,
        engine: "ddg",
        note: "!g → DuckDuckGo (Google blocks terminal clients).",
      };
    }
    return { ok: true, kind: "search", query, engine: "ddg" };
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) {
    if (!/^https?:\/\//i.test(text)) {
      // host:port like localhost:3000 — not a scheme, treat as a host
      if (/^[\w.-]+:\d+(\/.*)?$/.test(text)) {
        return { ok: true, kind: "url", url: `https://${text}` };
      }
      return { ok: false, error: "Only http(s) URLs are supported." };
    }
    return { ok: true, kind: "url", url: text };
  }

  if (!/\s/.test(text) && (text.includes(".") || text.includes(":"))) {
    return { ok: true, kind: "url", url: `https://${text}` };
  }
  if (!/\s/.test(text) && !text.includes(".")) {
    // Single word: could be a search or localhost-like host. Prefer search —
    // hosts with ports (`localhost:3000`) still match the branch above via ":".
    return { ok: true, kind: "search", query: text, engine: "ddg" };
  }

  return { ok: true, kind: "search", query: text, engine: "ddg" };
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface FetchedText {
  text: string;
  finalUrl: string;
  contentType: string;
  ms: number;
}

/** Plain fetch with timeout + browser UA, shared by pages and search. */
export async function fetchText(requestUrl: string): Promise<FetchedText> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(requestUrl, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.1",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    let text = await res.text();
    if (text.length > MAX_BODY_CHARS) text = text.slice(0, MAX_BODY_CHARS);
    return {
      text,
      finalUrl: res.url || requestUrl,
      contentType,
      ms: Date.now() - started,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${requestUrl}`);
    }
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPage(requestUrl: string): Promise<PageData> {
  const started = Date.now();
  let fetched: FetchedText;
  try {
    fetched = await fetchText(requestUrl);
  } catch (e) {
    throw new Error(`Failed to load ${requestUrl}: ${errMessage(e)}`);
  }
  const { text: raw, finalUrl, contentType } = fetched;

  if (contentType.includes("html") || !contentType) {
    const { title, markdown, links } = htmlToMarkdown(raw, finalUrl);
    return {
      requestUrl,
      finalUrl,
      title: title || finalUrl,
      markdown,
      links,
      contentType: contentType || "text/html (assumed)",
      ms: Date.now() - started,
    };
  }

  if (contentType.startsWith("text/")) {
    return {
      requestUrl,
      finalUrl,
      title: finalUrl,
      markdown: `# ${finalUrl}\n\n\`\`\`\n${raw}\n\`\`\``,
      links: [],
      contentType,
      ms: Date.now() - started,
    };
  }

  return {
    requestUrl,
    finalUrl,
    title: finalUrl,
    markdown:
      `# ${finalUrl}\n\n` +
      `Not renderable in the terminal reader (content-type: ${contentType}).`,
    links: [],
    contentType,
    ms: Date.now() - started,
  };
}
