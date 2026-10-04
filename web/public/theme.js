// The colour theme, applied before the page paints: a plain script in <head>,
// not a module, so it runs before the app (the app's CSP allows no inline
// script, so it is a file). The choice is a theme (pando, plannotator, iris or
// cloudflare) and a mode (system, dark or light), kept in localStorage
// ("pando-theme", "pando-mode"); ?theme=iris-light sets and keeps both
// (?theme=iris is its dark). Unset: Pando, dark. <html data-theme> gets the pair
// the page shows, as "iris-light"; System follows the computer while the page
// is open. window.pandoTheme is the app's handle on it (src/ui/theme.ts).
(function () {
  var THEMES = ["pando", "plannotator", "iris", "cloudflare"];
  var MODES = ["system", "dark", "light"];

  // The browser's bar takes each pair's ground (theme.css, --soil).
  var GROUNDS = {
    "pando-dark": "#0c0f0c",
    "pando-light": "#f0ece1",
    "plannotator-dark": "oklch(0.15 0.02 260)",
    "plannotator-light": "oklch(0.97 0.005 260)",
    "iris-dark": "#08090c",
    "iris-light": "#f4f5f7",
    "cloudflare-dark": "#141414",
    "cloudflare-light": "#fcfcfc",
  };

  var root = document.documentElement;
  var night = matchMedia("(prefers-color-scheme: dark)");
  var listeners = [];

  // "iris-light" or "iris" as { theme, mode }; null when it names no theme.
  function parse(text) {
    var parts = String(text || "").toLowerCase().split("-");

    if (THEMES.indexOf(parts[0]) < 0) return null;

    return { theme: parts[0], mode: MODES.indexOf(parts[1]) >= 0 ? parts[1] : null };
  }

  function stored(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function keep(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private mode or storage off: the choice lasts for this page only.
    }
  }

  var asked = null;

  try {
    asked = parse(new URLSearchParams(location.search).get("theme"));
  } catch {
    asked = null;
  }

  // An older build kept the pair itself ("iris-light") under pando-theme.
  var kept = parse(stored("pando-theme"));
  var keptMode = stored("pando-mode");
  var choice = { theme: kept ? kept.theme : "pando", mode: MODES.indexOf(keptMode) >= 0 ? keptMode : (kept && kept.mode) || "dark" };

  function shown() {
    if (choice.mode === "system") return night.matches ? "dark" : "light";

    return choice.mode;
  }

  function apply() {
    var pair = choice.theme + "-" + shown();
    var meta = document.querySelector('meta[name="theme-color"]');

    root.setAttribute("data-theme", pair);

    if (meta) meta.setAttribute("content", GROUNDS[pair]);

    for (var i = 0; i < listeners.length; i++) listeners[i]();
  }

  function set(next) {
    choice = {
      theme: THEMES.indexOf(next.theme) >= 0 ? next.theme : choice.theme,
      mode: MODES.indexOf(next.mode) >= 0 ? next.mode : choice.mode,
    };
    keep("pando-theme", choice.theme);
    keep("pando-mode", choice.mode);
    apply();
  }

  if (asked) set({ theme: asked.theme, mode: asked.mode || "dark" });
  else apply();

  night.addEventListener("change", function () {
    if (choice.mode === "system") apply();
  });

  window.pandoTheme = {
    get: function () {
      return choice;
    },
    shown: shown,
    set: set,
    subscribe: function (listener) {
      listeners.push(listener);

      return function () {
        listeners = listeners.filter(function (l) {
          return l !== listener;
        });
      };
    },
  };
})();
