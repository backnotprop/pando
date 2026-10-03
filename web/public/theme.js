// The colour theme, set before the page paints (as on the landing page and the
// prototype): ?theme= first (and kept), then the stored choice, else Pando.
// A plain script, not a module, so it runs before the first paint.
(function () {
  var colors = { pando: "#0C0F0C", "plannotator-dark": "oklch(0.15 0.02 260)", "plannotator-light": "oklch(0.97 0.005 260)", "iris-dark": "#08090c", "iris-light": "#f4f5f7" };
  var root = document.documentElement;

  function known(k) {
    if (!k) return null;
    k = String(k).toLowerCase();

    if (!colors[k] && colors[k + "-dark"]) k += "-dark";

    return colors[k] ? k : null;
  }

  var asked = null, kept = null;

  try { asked = known(new URLSearchParams(location.search).get("theme")); } catch {}

  try { kept = known(localStorage.getItem("pando-theme")); } catch {}

  var theme = asked || kept || "pando";

  if (theme !== "pando") root.setAttribute("data-theme", theme);
  var meta = document.querySelector('meta[name="theme-color"]');

  if (meta) meta.setAttribute("content", colors[theme]);

  if (asked) try { localStorage.setItem("pando-theme", asked); } catch {}
})();
