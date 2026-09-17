export interface PageLink {
  index: number;
  text: string;
  url: string;
}

export interface ReaderResult {
  title: string;
  markdown: string;
  links: PageLink[];
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITY_MAP[name] ?? m);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

export function cleanText(s: string): string {
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
}

/** Resolve href against the page URL. Returns null for non-navigable refs. */
export function resolveLink(href: string, base: string): string | null {
  const h = href.trim();
  if (
    !h ||
    h.startsWith("#") ||
    h.startsWith("javascript:") ||
    h.startsWith("mailto:") ||
    h.startsWith("tel:")
  ) {
    return null;
  }
  try {
    return new URL(h, base).href;
  } catch {
    return null;
  }
}

/**
 * Convert an HTML document to reader-mode markdown.
 * Links become `text [n]` with a numbered `## Links` section appended,
 * so the UI can follow link N on demand.
 */
export function htmlToMarkdown(html: string, baseUrl: string): ReaderResult {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch?.[1] ? cleanText(titleMatch[1]) : "";

  let body = html;
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) body = bodyMatch[1];

  // Drop non-content elements entirely.
  body = body
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, "")
    .replace(/<template[\s\S]*?<\/template\s*>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const links: PageLink[] = [];
  // Rewrite anchors first, while hrefs are still available.
  body = body.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
    (_m, attrs: string, inner: string) => {
      const text = cleanText(inner) || "(link)";
      const hrefMatch = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const href = hrefMatch?.[2] ?? hrefMatch?.[3] ?? hrefMatch?.[4] ?? "";
      const url = resolveLink(href, baseUrl);
      if (!url) return ` ${text} `;
      links.push({ index: links.length + 1, text, url });
      return ` ${text} [${links.length}] `;
    },
  );

  // Block structure -> markdown.
  body = body
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, code: string) => {
      const cleaned = decodeEntities(stripTags(code))
        .replace(/^\n+|\s+$/g, "");
      return `\n\n\`\`\`\n${cleaned}\n\`\`\`\n\n`;
    })
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi, (_m, t: string) => `\n\n# ${cleanText(t)}\n\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi, (_m, t: string) => `\n\n## ${cleanText(t)}\n\n`)
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/gi, (_m, t: string) => `\n\n### ${cleanText(t)}\n\n`)
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4\s*>/gi, (_m, t: string) => `\n\n#### ${cleanText(t)}\n\n`)
    .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5\s*>/gi, (_m, t: string) => `\n\n##### ${cleanText(t)}\n\n`)
    .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6\s*>/gi, (_m, t: string) => `\n\n###### ${cleanText(t)}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(li|ul|ol)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
    .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|blockquote|tr|table|figure)\s*>/gi, "\n\n")
    .replace(/<(p|div|section|article|header|footer|main|nav|aside|blockquote|tr|table|figure)\b[^>]*>/gi, "\n")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/(strong|b)\s*>/gi, (_m, _o, t: string) => `**${cleanText(t)}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/(em|i)\s*>/gi, (_m, _o, t: string) => `*${cleanText(t)}*`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, t: string) => `\`${cleanText(t)}\``);

  let text = decodeEntities(stripTags(body));
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\n(- )/g, "\n$1")
    .replace(/ \[(\d+)\] ([.,;:!?])/g, " [$1]$2")
    .trim();

  if (!title) {
    const h1 = text.match(/^# (.+)$/m);
    if (h1?.[1]) title = h1[1].trim();
  }

  if (!text) text = "(empty page — no readable text found)";

  if (links.length > 0) {
    const list = links
      .map((l) => `${l.index}. ${l.text} — ${l.url}`)
      .join("\n");
    text += `\n\n---\n\n## Links\n\n${list}`;
  }

  return { title, markdown: text, links };
}
