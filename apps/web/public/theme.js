// Applies the chosen color mode before the page paints, so it never flashes
// the other one. Kept as a file of its own: the site allows no inline scripts.
(function () {
  var dark = false;
  try {
    var mode = localStorage.getItem("theme");
    dark = mode === "dark" || (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch (e) {
    // Without storage or media queries the page stays light.
  }
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
