import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { RGBA, SyntaxStyle } from "@opentui/core";

/**
 * Theming, opencode-style with an Omarchy twist.
 *
 * Sources (lowest precedence first):
 * 1. built-in palettes (`dark`, `light`, `tokyonight`, `catppuccin`,
 *    `gruvbox`, `nord`)
 * 2. custom `*.json` files in `~/.config/opentui-browser/themes/`
 *    (respects `XDG_CONFIG_HOME`) and `./themes/`
 * 3. `theme` selection in config.json (`"system"` default)
 *
 * `system` adapts: if Omarchy has a staged theme
 * (`$XDG_STATE_HOME/omarchy/current/theme/colors.toml`, i.e. whatever
 * `omarchy-theme-set` last applied — Tokyo Night, Catppuccin, …),
 * its exact colors are used; otherwise the terminal's dark/light mode
 * picks the `dark`/`light` built-in.
 */

export type ThemeMode = "dark" | "light";

export interface ThemeTokens {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  link: string;
  code: string;
  listMarker: string;
  error: string;
  success: string;
  warning: string;
  selection: string;
}

export interface ResolvedTheme {
  /** Built-in/custom name, or `omarchy:<mode>` / `system:<mode>`. */
  name: string;
  mode: ThemeMode;
  colors: ThemeTokens;
  /** True when values came from the live Omarchy theme. */
  omarchy: boolean;
}

type PartialTokens = Partial<ThemeTokens> & { mode?: ThemeMode };

const DARK: ThemeTokens = {
  background: "#0d1117",
  foreground: "#e6edf3",
  muted: "#8b949e",
  border: "#30363d",
  accent: "#58a6ff",
  link: "#58a6ff",
  code: "#a5d6ff",
  listMarker: "#ff7b72",
  error: "#ff7b72",
  success: "#3fb950",
  warning: "#d29922",
  selection: "#264f78",
};

const LIGHT: ThemeTokens = {
  background: "#ffffff",
  foreground: "#1f2328",
  muted: "#59636e",
  border: "#d1d9e0",
  accent: "#0969da",
  link: "#0969da",
  code: "#0550ae",
  listMarker: "#d1242f",
  error: "#d1242f",
  success: "#1a7f37",
  warning: "#9a6700",
  selection: "#b6e3ff",
};

const BUILTINS: Record<string, { mode: ThemeMode; colors: ThemeTokens }> = {
  dark: { mode: "dark", colors: DARK },
  light: { mode: "light", colors: LIGHT },
  tokyonight: {
    mode: "dark",
    colors: {
      background: "#1a1b26",
      foreground: "#a9b1d6",
      muted: "#565f89",
      border: "#24283b",
      accent: "#7aa2f7",
      link: "#7aa2f7",
      code: "#449dab",
      listMarker: "#f7768e",
      error: "#f7768e",
      success: "#9ece6a",
      warning: "#e0af68",
      selection: "#292e42",
    },
  },
  catppuccin: {
    mode: "dark",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      muted: "#6c7086",
      border: "#313244",
      accent: "#89b4fa",
      link: "#89b4fa",
      code: "#94e2d5",
      listMarker: "#f38ba8",
      error: "#f38ba8",
      success: "#a6e3a1",
      warning: "#f9e2af",
      selection: "#45475a",
    },
  },
  gruvbox: {
    mode: "dark",
    colors: {
      background: "#282828",
      foreground: "#ebdbb2",
      muted: "#928374",
      border: "#3c3836",
      accent: "#83a598",
      link: "#83a598",
      code: "#8ec07c",
      listMarker: "#fb4934",
      error: "#fb4934",
      success: "#b8bb26",
      warning: "#fabd2f",
      selection: "#45403d",
    },
  },
  nord: {
    mode: "dark",
    colors: {
      background: "#2e3440",
      foreground: "#d8dee9",
      muted: "#4c566a",
      border: "#3b4252",
      accent: "#88c0d0",
      link: "#81a1c1",
      code: "#8fbcbb",
      listMarker: "#bf616a",
      error: "#bf616a",
      success: "#a3be8c",
      warning: "#ebcb8b",
      selection: "#434c5e",
    },
  },
};

export function listBuiltinThemes(): string[] {
  return [...Object.keys(BUILTINS), "system"];
}

/** Minimal flat `key = "value"` TOML reader (comments + blank lines skipped). */
export function parseFlatToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"(.*)"\s*$/) ?? line.match(/^([A-Za-z0-9_.-]+)\s*=\s*'(.*)'\s*$/);
    if (m?.[1]) out[m[1]] = m[2] ?? "";
  }
  return out;
}

/** Path of the live Omarchy staged theme, if this is an Omarchy system. */
export function omarchyColorsPath(): string | null {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
  const file = join(state, "omarchy/current/theme/colors.toml");
  return existsSync(file) ? file : null;
}

/** Read the staged Omarchy theme into tokens, or null when unavailable. */
export function readOmarchyTheme(): { mode: ThemeMode; colors: ThemeTokens } | null {
  const file = omarchyColorsPath();
  if (!file) return null;
  try {
    const t = parseFlatToml(readFileSync(file, "utf8"));
    if (!t.background || !t.foreground) return null;
    const mode: ThemeMode = t.mode === "light" ? "light" : "dark";
    return {
      mode,
      colors: {
        background: t.background,
        foreground: t.foreground,
        muted: t.muted ?? t.dark_foreground ?? DARK.muted,
        border: t.lighter_background ?? t.selection ?? DARK.border,
        accent: t.accent ?? t.blue ?? DARK.accent,
        link: t.blue ?? t.accent ?? DARK.link,
        code: t.cyan ?? DARK.code,
        listMarker: t.red ?? DARK.listMarker,
        error: t.red ?? DARK.error,
        success: t.green ?? DARK.success,
        warning: t.yellow ?? t.orange ?? DARK.warning,
        selection: t.selection ?? DARK.selection,
      },
    };
  } catch {
    return null;
  }
}

export function themeDirs(cwd = process.cwd()): string[] {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return [join(base, "opentui-browser/themes"), resolve(cwd, "themes")];
}

/** Load a custom theme file by name (without extension). Later dirs win. */
export function loadCustomTheme(name: string, cwd = process.cwd()): PartialTokens | null {
  let found: PartialTokens | null = null;
  for (const dir of themeDirs(cwd)) {
    const file = join(dir, `${name}.json`);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as PartialTokens;
      if (parsed && typeof parsed === "object") found = parsed;
    } catch {
      // ignore invalid files — builtins remain available
    }
  }
  return found;
}

export function listCustomThemes(cwd = process.cwd()): string[] {
  const names = new Set<string>();
  for (const dir of themeDirs(cwd)) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".json")) names.add(basename(f, ".json"));
      }
    } catch {
      // dir may not exist
    }
  }
  return [...names];
}

/** `"none"` means transparent (terminal default shows through). */
function concrete(value: string | undefined, fallback: string): string {
  if (!value || value === "none") return value === "none" ? "transparent" : fallback;
  return value;
}

function applyPartial(base: ThemeTokens, over: PartialTokens): ThemeTokens {
  const out = { ...base };
  (Object.keys(out) as (keyof ThemeTokens)[]).forEach((k) => {
    out[k] = concrete(over[k], out[k]);
  });
  return out;
}

export interface ResolveOptions {
  /** Name from config.json: builtin, custom file, or "system" (default). */
  themeName?: string;
  /** Terminal dark/light mode from the renderer (used by "system"). */
  terminalMode?: ThemeMode | null;
}

export function resolveTheme(opts: ResolveOptions = {}): ResolvedTheme {
  const name = (opts.themeName ?? "system").toLowerCase();

  if (name !== "system") {
    const builtin = BUILTINS[name];
    if (builtin) {
      return { name, mode: builtin.mode, colors: { ...builtin.colors }, omarchy: false };
    }
    const custom = loadCustomTheme(name);
    if (custom) {
      const base = custom.mode === "light" ? LIGHT : DARK;
      return {
        name,
        mode: custom.mode ?? "dark",
        colors: applyPartial(base, custom),
        omarchy: false,
      };
    }
    return { name: "dark", mode: "dark", colors: { ...DARK }, omarchy: false };
  }

  const omarchy = readOmarchyTheme();
  if (omarchy) {
    return { name: `omarchy:${omarchy.mode}`, mode: omarchy.mode, colors: omarchy.colors, omarchy: true };
  }
  const mode: ThemeMode = opts.terminalMode === "light" ? "light" : "dark";
  const base = mode === "light" ? LIGHT : DARK;
  return { name: `system:${mode}`, mode, colors: { ...base }, omarchy: false };
}

/** Build the reader markdown style from a resolved theme (needs native FFI). */
export function syntaxStyleFromTheme(theme: ResolvedTheme): SyntaxStyle {
  const c = theme.colors;
  return SyntaxStyle.fromStyles({
    "markup.heading.1": { fg: RGBA.fromHex(c.accent), bold: true },
    "markup.heading.2": { fg: RGBA.fromHex(c.link), bold: true },
    "markup.heading.3": { fg: RGBA.fromHex(c.link) },
    "markup.heading.4": { fg: RGBA.fromHex(c.link) },
    "markup.heading.5": { fg: RGBA.fromHex(c.link) },
    "markup.heading.6": { fg: RGBA.fromHex(c.link) },
    "markup.list": { fg: RGBA.fromHex(c.listMarker) },
    "markup.raw": { fg: RGBA.fromHex(c.code) },
    "markup.link": { fg: RGBA.fromHex(c.link), underline: true },
    "markup.bold": { bold: true },
    "markup.italic": { italic: true },
    default: { fg: RGBA.fromHex(c.foreground) },
  });
}
