import { htmlToMarkdown } from "./html-to-markdown";
import { fetchText } from "./web";
import type { AiFileConfig } from "./config";

export type AnswerProvider = "anthropic" | "openai";

export interface AnswerConfig {
  provider: AnswerProvider;
  apiKey: string;
  model: string;
  /** OpenAI-compatible base URL (Anthropic ignores this). */
  baseUrl?: string;
  label: string;
}

export interface AnswerSource {
  /** 1-based number matching the results page Links section. */
  index: number;
  title: string;
  url: string;
  text: string;
}

const DEFAULT_MODELS: Record<AnswerProvider, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
};

const FILE_KEY_NAMES: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
  google: "GEMINI_API_KEY",
};

/**
 * Detect configuration. Precedence:
 * 1. explicit `AI_PROVIDER` env, 2. provider keys in env
 * (Anthropic → OpenAI → OpenRouter → Gemini), 3. `config.json` ai section,
 * 4. Ollama via `AI_BASE_URL`/`OLLAMA_HOST`.
 * `AI_MODEL`/`AI_BASE_URL` env always beat config-file values.
 */
export function detectAnswerConfig(
  env: NodeJS.ProcessEnv = process.env,
  file?: AiFileConfig,
): AnswerConfig | null {
  const e: NodeJS.ProcessEnv = { ...env };
  const fileProvider = (file?.provider ?? "").toLowerCase();
  const hasEnvKey = Boolean(
    e.ANTHROPIC_API_KEY || e.OPENAI_API_KEY || e.OPENROUTER_API_KEY || e.GEMINI_API_KEY,
  );
  if (file?.apiKey && fileProvider && !hasEnvKey && !(e.AI_PROVIDER ?? "").trim()) {
    // Ignore untouched template placeholders so a fresh config.json
    // behaves like no config until the user pastes a real key.
    if (!/PASTE|EXAMPLE|YOUR[-_ ]?KEY|xxx+/i.test(file.apiKey)) {
      const keyName = FILE_KEY_NAMES[fileProvider];
      if (keyName) e[keyName] = file.apiKey;
    }
  }
  if (file?.model && !e.AI_MODEL) e.AI_MODEL = file.model;
  if (file?.baseUrl && !e.AI_BASE_URL) e.AI_BASE_URL = file.baseUrl;

  const forced = (e.AI_PROVIDER ?? "").toLowerCase();
  const model = e.AI_MODEL?.trim();
  const baseUrl = e.AI_BASE_URL?.trim();

  if (forced === "anthropic" || forced === "openai") {
    const apiKey = e.AI_API_KEY ?? e.ANTHROPIC_API_KEY ?? e.OPENAI_API_KEY ?? "";
    if (!apiKey) return null;
    return {
      provider: forced,
      apiKey,
      model: model ?? DEFAULT_MODELS[forced],
      baseUrl: forced === "openai" ? baseUrl : undefined,
      label: forced,
    };
  }

  if (e.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      apiKey: e.ANTHROPIC_API_KEY,
      model: model ?? DEFAULT_MODELS.anthropic,
      label: "anthropic",
    };
  }
  if (e.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: e.OPENAI_API_KEY,
      model: model ?? DEFAULT_MODELS.openai,
      baseUrl: baseUrl ?? "https://api.openai.com/v1",
      label: "openai",
    };
  }
  if (e.OPENROUTER_API_KEY) {
    return {
      provider: "openai",
      apiKey: e.OPENROUTER_API_KEY,
      model: model ?? "openai/gpt-4o-mini",
      baseUrl: baseUrl ?? "https://openrouter.ai/api/v1",
      label: "openrouter",
    };
  }
  if (e.GEMINI_API_KEY) {
    return {
      provider: "openai",
      apiKey: e.GEMINI_API_KEY,
      model: model ?? "gemini-2.5-flash",
      baseUrl: baseUrl ?? "https://generativelanguage.googleapis.com/v1beta/openai/",
      label: "gemini",
    };
  }
  // Local Ollama exposes an OpenAI-compatible API; only use it if reachable
  // config exists — actual reachability is checked at call time.
  if (baseUrl || e.OLLAMA_HOST) {
    return {
      provider: "openai",
      apiKey: e.AI_API_KEY ?? "ollama",
      model: model ?? "llama3.1",
      baseUrl: baseUrl ?? `${e.OLLAMA_HOST ?? "http://localhost:11434"}/v1`,
      label: "ollama",
    };
  }
  return null;
}

const MAX_SOURCES = 5;
const CHARS_PER_SOURCE = 3500;

/** Fetch the top results and distill each to plain reader text. */
export async function gatherSources(
  results: { title: string; url: string }[],
): Promise<AnswerSource[]> {
  const top = results.slice(0, MAX_SOURCES);
  const settled = await Promise.allSettled(
    top.map(async (r, i) => {
      const { text, finalUrl, contentType } = await fetchText(r.url);
      let body: string;
      if (contentType.includes("html") || !contentType) {
        body = htmlToMarkdown(text, finalUrl).markdown;
      } else if (contentType.startsWith("text/")) {
        body = text;
      } else {
        throw new Error(`unreadable ${contentType}`);
      }
      body = body.replace(/\n{3,}/g, "\n\n").trim().slice(0, CHARS_PER_SOURCE);
      if (!body) throw new Error("empty");
      return { index: i + 1, title: r.title, url: r.url, text: body };
    }),
  );
  const sources: AnswerSource[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") sources.push(s.value);
  }
  return sources.sort((a, b) => a.index - b.index);
}

const SYSTEM_PROMPT = [
  "You answer web-search queries using ONLY the numbered sources provided.",
  "Every factual claim must carry its citation as [N] matching the source number.",
  "If the sources don't contain the answer, say so briefly instead of guessing.",
  "Be concise: a short direct answer first, then 3-6 key points at most.",
  "Reply in Markdown. Do not add a Sources list — citations inline only.",
].join(" ");

export function buildAnswerPrompt(query: string, sources: AnswerSource[]): string {
  const docs = sources
    .map((s) => `### [${s.index}] ${s.title}\n${s.url}\n\n${s.text}`)
    .join("\n\n---\n\n");
  return `Query: ${query}\n\nSources:\n\n${docs}`;
}

async function callAnthropic(cfg: AnswerConfig, prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`AI provider HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const text = json.content?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") ?? "";
  if (!text.trim()) throw new Error("AI provider returned an empty answer.");
  return text.trim();
}

async function callOpenAICompatible(cfg: AnswerConfig, prompt: string): Promise<string> {
  const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 800,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI provider HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("AI provider returned an empty answer.");
  return text.trim();
}

/** Generate a cited markdown answer from gathered sources. */
export async function generateAnswer(
  query: string,
  sources: AnswerSource[],
  cfg: AnswerConfig,
): Promise<string> {
  if (sources.length === 0) throw new Error("No readable sources to summarize.");
  const prompt = buildAnswerPrompt(query, sources);
  return cfg.provider === "anthropic"
    ? callAnthropic(cfg, prompt)
    : callOpenAICompatible(cfg, prompt);
}

/** Prepend the answer section; citations [N] match the page's Links section. */
export function attachAnswer(markdown: string, answer: string, modelLabel: string): string {
  return `## Answer\n\n${answer}\n\n_AI summary (${modelLabel}) — citations refer to the Links below._\n\n---\n\n${markdown}`;
}
