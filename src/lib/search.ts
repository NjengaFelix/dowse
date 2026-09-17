import { cleanText, decodeEntities, type PageLink } from "./html-to-markdown";
import { fetchText, type PageData } from "./web";

export type SearchEngine = "ddg" | "bing";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const ENGINE_LABEL: Record<SearchEngine, string> = {
  ddg: "DuckDuckGo",
  bing: "Bing",
};

function decodeDdgHref(href: string): string {
  // DDG wraps results: //duckduckgo.com/l/?uddg=<encoded-url>&rut=...
  // Raw HTML hrefs are entity-encoded (&amp;), so decode first.
  try {
    const u = new URL(decodeEntities(href), "https://duckduckgo.com");
    const real = u.searchParams.get("uddg");
    if (real) return real;
    return u.href;
  } catch {
    return href;
  }
}

function parseDdg(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe =
    /<a\b([^>]*class="result__a"[^>]*)>([\s\S]*?)<\/a\s*>/gi;
  const anchors: { href: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1];
    const hrefMatch = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)')/i);
    const href = hrefMatch?.[2] ?? hrefMatch?.[3] ?? "";
    const title = cleanText(m[2] ?? "");
    if (href && title) anchors.push({ href, title });
  }
  const snippetRe =
    /class="result__snippet"[^>]*>([\s\S]*?)<\/a\s*>/gi;
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(cleanText(m[1] ?? ""));
  }
  anchors.forEach((a, i) => {
    results.push({
      title: a.title,
      url: decodeDdgHref(a.href),
      snippet: snippets[i] ?? "",
    });
  });
  return results;
}

/** DuckDuckGo serves a JS challenge page when it flags the client as a bot. */
export function isDdgChallenge(html: string): boolean {
  return /anomaly-modal|challenge-form|anomaly\.js|duckduckgo\.com\/anomaly/i.test(html);
}

function parseDdgLite(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // NB: in lite markup href comes before class:
  // <a rel="nofollow" href="//duckduckgo.com/l/?uddg=..." class='result-link'>
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  const links: { href: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1];
    if (!/class=['"]result-link['"]/i.test(attrs)) continue;
    const hrefMatch = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)')/i);
    const href = hrefMatch?.[2] ?? hrefMatch?.[3] ?? "";
    const title = cleanText(m[2] ?? "");
    if (href && title) links.push({ href, title });
  }
  const snippetRe =
    /<td\b[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td\s*>/gi;
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(cleanText(m[1] ?? ""));
  }
  links.forEach((a, i) => {
    results.push({
      title: a.title,
      url: decodeDdgHref(a.href),
      snippet: snippets[i] ?? "",
    });
  });
  return results;
}

function parseBingRss(xml: string): SearchResult[] {
  const results: SearchResult[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const item = m[1];
    const pick = (tag: string) => {
      const mm = item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return mm?.[1] ? decodeEntities(mm[1]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
    };
    const title = cleanText(pick("title"));
    const url = pick("link");
    if (!title || !url) continue;
    results.push({ title, url, snippet: cleanText(pick("description")) });
  }
  return results;
}

/** Run a web search and shape the results as a followable reader page. */
export async function searchWeb(
  query: string,
  engine: SearchEngine,
): Promise<PageData> {
  const started = Date.now();
  let results: SearchResult[] = [];
  let requestUrl: string;
  if (engine === "bing") {
    requestUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
    const { text } = await fetchText(requestUrl);
    results = parseBingRss(text);
  } else {
    // Small anti-captcha chain: DDG's /html/ endpoint is a POST form and
    // rate-limits plain GETs with an "anomaly" challenge page. Try POST
    // first (official form method), then GET, then the ultra-light /lite/
    // endpoint (different markup, rarely challenged).
    const attempts: { url: string; form?: Record<string, string> }[] = [
      { url: "https://html.duckduckgo.com/html/", form: { q: query } },
      {
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      },
      {
        url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      },
    ];
    let challenged = false;
    let lastUrl = attempts[0].url;
    for (const [i, a] of attempts.entries()) {
      lastUrl = a.url;
      const { text } = await fetchText(a.url, a.form ? { form: a.form } : undefined);
      if (isDdgChallenge(text)) {
        challenged = true;
        continue;
      }
      results = i === 2 ? parseDdgLite(text) : parseDdg(text);
      // Empty-but-clean pages happen (e.g. odd queries); only the
      // challenge page is worth retrying — don't burn all fallbacks.
      break;
    }
    requestUrl = lastUrl;
    if (challenged && results.length === 0) {
      throw new Error("Search engine asked for bot verification — automatically retried lite endpoint, still blocked. Try !b for Bing.");
    }
  }

  const links: PageLink[] = results.map((r, i) => ({
    index: i + 1,
    text: r.title,
    url: r.url,
  }));

  let markdown = `# Search: ${query}\n\n_${ENGINE_LABEL[engine]} · ${results.length} results · ${Date.now() - started}ms_\n`;
  if (results.length === 0) {
    markdown += `\nNo results. Try different terms or \`!b ${query}\` for Bing.\n`;
  } else {
    for (const [i, r] of results.entries()) {
      markdown += `\n## ${i + 1}. ${r.title}\n\n`;
      if (r.snippet) markdown += `${r.snippet}\n\n`;
    }
    markdown += `\n---\n\n## Links\n\n`;
    markdown += links.map((l) => `${l.index}. ${l.text} — ${l.url}`).join("\n");
  }

  return {
    requestUrl,
    finalUrl: requestUrl,
    title: `Search: ${query}`,
    markdown,
    links,
    contentType: "search-results",
    ms: Date.now() - started,
  };
}
