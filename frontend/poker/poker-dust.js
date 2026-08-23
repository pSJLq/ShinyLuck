/* Ambient dust for the poker screens.
   Replaces the GridField canvas that used to paint these backgrounds. That
   canvas walked rows x cols every animation frame doing five transcendental
   calls and a fresh fillStyle string PER CELL (~3000 cells on the lobby, so
   ~186k cells/second at vsync) - a steady core of CPU behind a backdrop, and
   it ran at the table too, competing with the zkShuffle crypto during a hand.
   This is the casino shell's effect instead: six drifting sparks, pure CSS,
   composited, with the glow baked into each spark's gradient so no filter has
   to be re-rasterised. The felt canvas and its deal-scramble are NOT touched -
   those are gameplay visuals, not wallpaper. */
(function () {
  "use strict";
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // x%, y%, drift seconds, twinkle seconds
  var DUST = [[8, 22, 13, 5.5], [21, 64, 16, 7], [47, 78, 18, 8], [69, 16, 15, 9], [88, 30, 17, 7.4], [93, 74, 15, 6]];

  var CSS = [
    ".sp-dust{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}",
    ".sp-dust span{position:absolute;display:block}",
    ".sp-dust i{position:absolute;display:block;width:9px;height:9px;margin:-3px 0 0 -3px;border-radius:999px;",
    "background:radial-gradient(circle,#F6F1E7 0%,rgba(217,185,112,.92) 17%,rgba(217,185,112,.4) 38%,rgba(217,185,112,.12) 58%,transparent 76%);",
    "opacity:0;will-change:opacity,transform}",
    "@keyframes sp-drift{0%{transform:translate3d(0,14px,0)}100%{transform:translate3d(0,-46px,0)}}",
    "@keyframes sp-twinkle{0%,100%{opacity:0;transform:scale(.35)}50%{opacity:.85;transform:scale(1)}}",
    /* CSS animations keep running in a background tab (unlike JS timers), so
       stop them by hand when the tab is hidden. */
    "html.sp-hidden *,html.sp-hidden *::before,html.sp-hidden *::after{animation-play-state:paused!important}",
  ].join("");

  function mount() {
    if (document.querySelector(".sp-dust")) return;
    var st = document.createElement("style");
    st.setAttribute("data-sp-dust", "");
    st.textContent = CSS;
    document.head.appendChild(st);
    var d = document.createElement("div");
    d.className = "sp-dust";
    d.setAttribute("aria-hidden", "true");
    d.innerHTML = DUST.map(function (p, i) {
      return '<span style="left:' + p[0] + "%;top:" + p[1] + "%;animation:sp-drift " + p[2] + "s ease-in-out " + (i * 0.4) +
        's infinite alternate"><i style="animation:sp-twinkle ' + p[3] + "s ease-in-out " + (i % 4) + 's infinite"></i></span>';
    }).join("");
    document.body.appendChild(d);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  var sync = function () { document.documentElement.classList.toggle("sp-hidden", document.hidden); };
  document.addEventListener("visibilitychange", sync);
  sync();
})();
