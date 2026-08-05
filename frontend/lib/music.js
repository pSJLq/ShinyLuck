/* Background music · the whole casino, not just the poker tables.
 *
 * THE MUSIC: the owner's 3h18m lounge mix, cut into its twelve tracks by the
 * timecodes he listed (`/assets/music/*.mp3`). It is a PLAYLIST and not one
 * long file for one reason: a browser handed a single 183 MB file downloads
 * 183 MB, while a playlist only ever fetches the track that is playing.
 * Nothing at all is fetched until the music is switched on.
 *
 * WHERE IT RUNS — the TOP document only. Every game and the poker table live
 * in the shell's iframe, and each of those pages loads this file too; without
 * the guard you would get two, three, four copies of the same track playing
 * over each other. Running it in the shell also means the music survives
 * navigation between games instead of restarting at every click.
 * `fx()` is exempt: it is a pure preference read that the framed table needs
 * for its own click sounds.
 *
 * It obeys the casino's Settings panel — the same localStorage keys and the
 * same `shinyluck:sound` event the slots listen to. The speaker button in the
 * sidebar is a master mute over both channels.
 *
 * Autoplay: browsers refuse to start audio before a gesture, so it arms itself
 * and begins at the first click/key/touch. A hidden tab is silent.
 */
(function () {
  "use strict";
  if (window.SPMusic) return;

  var DIR = "/assets/music/";
  var TRACKS = [
    { f: "01-premium-lounge.mp3",           t: "Premium Lounge" },
    { f: "02-romantic-jazz.mp3",            t: "Romantic Jazz" },
    { f: "03-dancing-with-somebody-new.mp3", t: "Dancing with Somebody New" },
    { f: "04-city-lights.mp3",              t: "City Lights Lounge" },
    { f: "05-gentle-piano.mp3",             t: "Gentle Piano" },
    { f: "06-lobby-bar-jazz.mp3",           t: "Lobby Bar Jazz" },
    { f: "07-deep-relaxation.mp3",          t: "Deep Relaxation" },
    { f: "08-i-remember.mp3",               t: "I Remember" },
    { f: "09-spa-ambience.mp3",             t: "Spa & Meditation" },
    { f: "10-morning-jazz.mp3",             t: "Morning Jazz" },
    { f: "11-soft-evening-beats.mp3",       t: "Soft Evening Beats" },
    { f: "12-final-harmony.mp3",            t: "Final Harmony" },
  ];

  var K_ON = "sl-music-on", K_VOL = "sl-vol-music", K_FX = "sl-sound-on", K_FXVOL = "sl-vol-fx";

  /** FX volume from the Settings panel · needed by framed pages too (the poker
   *  table's own chip/click sounds), so it is defined before the top-window
   *  guard and exported either way. */
  function fxVolume() {
    try {
      if (localStorage.getItem(K_FX) === "0") return 0;
      var v = parseInt(localStorage.getItem(K_FXVOL) || "40", 10);
      return isFinite(v) ? Math.min(100, Math.max(0, v)) / 100 : 0.4;
    } catch (e) { return 0.4; }
  }

  var isTop = true;
  try { isTop = window.self === window.top; } catch (e) { isTop = false; }
  if (!isTop) {
    // FRAMED: no player here — but the gesture that unlocks audio almost always
    // lands in HERE, because the frame is where the game is. Events do not
    // cross a frame boundary, so the shell above would sit forever waiting for
    // a click it can never see. Pass the first one up.
    var told = false;
    var tell = function () {
      if (told) return;
      told = true;
      try { window.parent.postMessage({ type: "sl-gesture" }, "*"); } catch (e) {}
    };
    ["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
      window.addEventListener(ev, tell, { passive: true });
    });
    window.SPMusic = { fx: fxVolume, framed: true, isOn: function () { return false; },
      refresh: function () {}, state: function () { return { framed: true }; } };
    return;
  }

  // Default ON. The pages are a casino; a room with no music is the odd one.
  var readOn = function () { try { return localStorage.getItem(K_ON) !== "0"; } catch (e) { return true; } };
  var readVol = function () {
    try { var v = parseInt(localStorage.getItem(K_VOL) || "35", 10); return isFinite(v) ? Math.min(100, Math.max(0, v)) : 35; }
    catch (e) { return 35; }
  };

  var el = null, armed = false, fadeTimer = null, ix = 0, order = [], fails = 0;

  // A different running order per session, so the same two tracks do not open
  // every visit. Fisher-Yates.
  function shuffle() {
    order = TRACKS.map(function (_, i) { return i; });
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), tmp = order[i];
      order[i] = order[j]; order[j] = tmp;
    }
    ix = 0;
  }
  shuffle();
  var current = function () { return TRACKS[order[ix % order.length]]; };

  function want() {
    // hidden tab = silence · music you cannot see is just a laptop fan
    if (!readOn() || document.hidden) return 0;
    // gentle curve · the slider should feel linear to the ear, and background
    // music never wants the top of the range
    return Math.pow(readVol() / 100, 1.15) * 0.9;
  }

  function load(play) {
    el.src = DIR + current().f;
    if (play) {
      var p = el.play();
      if (p && p.catch) p.catch(function () { /* autoplay refused · a gesture retries */ });
    }
  }

  function next() {
    ix = (ix + 1) % order.length;
    if (ix === 0) shuffle();
    load(true);
    fadeTo(want(), 1400);
  }

  function build() {
    el = new Audio();
    el.preload = "none";     // nothing until it is actually wanted
    el.volume = 0;
    el.addEventListener("ended", function () { fails = 0; next(); });
    // A missing or unplayable file must not end the music · step over it.
    el.addEventListener("error", function () {
      if (++fails >= TRACKS.length) return; // every track failed · stop trying
      next();
    });
    load(false);
    return el;
  }

  /** Ramp rather than jump · a track that snaps to full volume is startling. */
  function fadeTo(target, ms) {
    if (!el) return;
    clearInterval(fadeTimer);
    var from = el.volume, steps = Math.max(1, Math.round(ms / 50)), i = 0;
    fadeTimer = setInterval(function () {
      i++;
      var v = from + (target - from) * (i / steps);
      try { el.volume = Math.min(1, Math.max(0, v)); } catch (e) {}
      if (i >= steps) {
        clearInterval(fadeTimer);
        if (target <= 0 && el) { try { el.pause(); } catch (e) {} }
      }
    }, 50);
  }

  function applyPrefs() {
    var v = want();
    // NOTHING IS FETCHED UNTIL THE MUSIC IS ACTUALLY WANTED — megabytes are not
    // a download to make on behalf of someone who turned it off.
    if (!el) { if (v <= 0 || !armed) return; build(); }
    if (v > 0) {
      if (el.paused) {
        var p = el.play();
        if (p && p.catch) p.catch(function () { /* autoplay refused · a gesture retries */ });
      }
      fadeTo(v, 900);
    } else {
      fadeTo(0, 500);
    }
  }

  function arm() { armed = true; applyPrefs(); }
  ["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
    window.addEventListener(ev, arm, { passive: true });
  });
  // …and a gesture that happened inside one of our own frames counts too.
  window.addEventListener("message", function (e) {
    if (e && e.data && e.data.type === "sl-gesture") arm();
  });

  // The shell writes the settings; `storage` fires in every OTHER same-origin
  // document (so: the shell's write reaches this iframe), the CustomEvent
  // covers this one.
  window.addEventListener("storage", function (e) {
    if (!e || (e.key !== K_ON && e.key !== K_VOL && e.key !== K_FX)) return;
    applyPrefs();
  });
  document.addEventListener("shinyluck:sound", applyPrefs);
  document.addEventListener("visibilitychange", applyPrefs);

  window.SPMusic = {
    refresh: applyPrefs,
    isOn: readOn,
    /** Skip · not wired to any button yet, but this is the one control a
     *  listener always wants and it costs a line. */
    skip: function () { if (el) { fails = 0; next(); } },
    nowPlaying: function () { return current().t; },
    /** What is actually happening — the element is created by `new Audio()` and
     *  never enters the DOM, so this is the only way to tell "downloading" from
     *  "playing" when checking the live site. */
    state: function () {
      if (!el) return { built: false, armed: armed, on: readOn() };
      return { built: true, armed: armed, on: readOn(), paused: el.paused,
        track: current().t, volume: Math.round(el.volume * 1000) / 1000,
        at: Math.round(el.currentTime * 10) / 10 };
    },
    /** FX volume from the SAME panel, for the click/chip sounds — they used to
     *  obey only an on/off flag and ignore the slider entirely. */
    fx: fxVolume,
  };
})();
