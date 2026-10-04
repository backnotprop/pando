// The colour theme, applied before the page paints: a plain script in <head>,
// not a module, so it runs before the app (the app's CSP allows no inline
// script, so it is a file). The choice is a theme (pando, plannotator, iris,
// cloudflare or black-rainbow) and a mode (system, dark or light), kept in
// localStorage ("pando-theme", "pando-mode"); ?theme=iris-light sets and keeps
// both (?theme=iris is its dark). Unset: Pando, dark. <html data-theme> gets
// the pair the page shows, as "iris-light"; a dark-only theme is its name
// alone ("black-rainbow"), whatever the mode, which stays kept for the others.
// System follows the computer while the page is open. window.pandoTheme is the
// app's handle on it (src/ui/theme.ts).
(function () {
  var THEMES = ["pando", "plannotator", "iris", "cloudflare", "black-rainbow"];
  var DARK_ONLY = ["black-rainbow"];
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
    "black-rainbow": "#000000",
  };

  var root = document.documentElement;
  var night = matchMedia("(prefers-color-scheme: dark)");
  var listeners = [];

  // "iris-light", "iris" or "black-rainbow" as { theme, mode }; null when it names no theme.
  function parse(text) {
    text = String(text || "").toLowerCase();

    for (var i = 0; i < THEMES.length; i++) {
      var rest = text.slice(THEMES[i].length);

      if (text.indexOf(THEMES[i]) === 0 && (rest === "" || rest.charAt(0) === "-")) {
        return { theme: THEMES[i], mode: MODES.indexOf(rest.slice(1)) >= 0 ? rest.slice(1) : null };
      }
    }

    return null;
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

  function darkOnly() {
    return DARK_ONLY.indexOf(choice.theme) >= 0;
  }

  function shown() {
    if (darkOnly()) return "dark";

    if (choice.mode === "system") return night.matches ? "dark" : "light";

    return choice.mode;
  }

  function apply() {
    var pair = darkOnly() ? choice.theme : choice.theme + "-" + shown();
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

  if (asked) set({ theme: asked.theme, mode: asked.mode || (DARK_ONLY.indexOf(asked.theme) >= 0 ? choice.mode : "dark") });
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
