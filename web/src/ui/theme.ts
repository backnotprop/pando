// The colour theme people pick in the name menu (owner ruling): Pando,
// Plannotator, Iris or Cloudflare, each dark and light, and the mode (System
// follows the computer). public/theme.js applies and keeps it before the page
// paints; this is the app's typed handle on it.
import { useSyncExternalStore } from "react";

export type Theme = "pando" | "plannotator" | "iris" | "cloudflare";

export type Mode = "system" | "dark" | "light";

export interface ThemeChoice {
  readonly theme: Theme;
  readonly mode: Mode;
}

interface ThemeHandle {
  get(): ThemeChoice;
  /** The mode the page shows: System resolved to the computer's. */
  shown(): "dark" | "light";
  set(next: Partial<ThemeChoice>): void;
  subscribe(listener: () => void): () => void;
}

declare global {
  interface Window {
    /** public/theme.js; missing only if that file failed to load. */
    pandoTheme?: ThemeHandle;
  }
}

export const THEMES: readonly { id: Theme; label: string }[] = [
  { id: "pando", label: "Pando" },
  { id: "plannotator", label: "Plannotator" },
  { id: "iris", label: "Iris" },
  { id: "cloudflare", label: "Cloudflare" },
];

export const MODES: readonly { id: Mode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

const UNSET: ThemeChoice = { theme: "pando", mode: "dark" };

const subscribe = (listener: () => void) => window.pandoTheme?.subscribe(listener) ?? (() => undefined);

export const shownMode = () => window.pandoTheme?.shown() ?? "dark";

export const setTheme = (next: Partial<ThemeChoice>) => window.pandoTheme?.set(next);

export const useThemeChoice = () => useSyncExternalStore(subscribe, () => window.pandoTheme?.get() ?? UNSET);

export const useShownMode = () => useSyncExternalStore(subscribe, shownMode);
