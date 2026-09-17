import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AiFileConfig {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface AppConfig {
  ai?: AiFileConfig;
  /** Theme selection: "system" (default), a built-in, or a custom file name. */
  theme?: string;
}

export const APP_DIR = "opentui-browser";
export const CONFIG_FILE = "config.json";

/** Config search paths, lowest precedence first (opencode-style layering). */
export function configPaths(cwd = process.cwd()): string[] {
  const paths: string[] = [];
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  paths.push(join(base, APP_DIR, CONFIG_FILE));
  const project = resolve(cwd, CONFIG_FILE);
  if (project !== paths[0]) paths.push(project);
  return paths;
}

/** Read one JSON config file. Missing/invalid files yield {} — never throws. */
export function loadConfigFile(file: string): AppConfig {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as AppConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    if (!parsed.ai || typeof parsed.ai !== "object") return {};
    const ai: AiFileConfig = { ...parsed.ai };
    // Drop untouched template placeholders so they never shadow real values
    // from lower-precedence files during the merge.
    if (!ai.apiKey || /PASTE|EXAMPLE|YOUR[-_ ]?KEY|xxx+/i.test(ai.apiKey)) {
      delete ai.apiKey;
    }
    return { ai };
  } catch {
    return {};
  }
}

function mergeConfig(base: AppConfig, over: AppConfig): AppConfig {
  if (!over.ai) return base;
  return { ai: { ...base.ai, ...over.ai } };
}

/**
 * Load layered config: user-global (`~/.config/opentui-browser/config.json`,
 * respecting `XDG_CONFIG_HOME`) then project-local `./config.json`,
 * merged per-field with project winning. Never throws.
 */
export function loadAppConfig(cwd = process.cwd()): AppConfig {
  let merged: AppConfig = {};
  for (const file of configPaths(cwd)) {
    merged = mergeConfig(merged, loadConfigFile(file));
  }
  return merged;
}
