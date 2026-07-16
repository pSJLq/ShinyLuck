/* Somnia LED-grid motion engine.
   Renders the brand's animated pixel/dot-matrix field: dim cells on black with
   moving diagonal bands of accent light. Powers ambient backgrounds, the felt
   texture, the zkShuffle "scramble" reveal, and glow pulses.
   Vanilla JS · instantiate with new GridField(canvas, opts). */
(function () {
  "use strict";

  function hexToRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function GridField(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cell = opts.cell || 13;          // cell pitch in px (incl gap)
    this.gap = opts.gap != null ? opts.gap : 3;
    this.speed = opts.speed != null ? opts.speed : 1;     // flow speed multiplier
    this.density = opts.density != null ? opts.density : 1; // how much of grid lights
    this.base = hexToRgb(opts.base || '#101014');         // dim cell color
    this.accent = hexToRgb(opts.accent || '#d9ab4a');     // hero accent
    this.accent2 = hexToRgb(opts.accent2 || '#d9ab4a');   // secondary band
    this.bg = opts.bg || '#070707';
    this.shape = opts.shape || 'square';   // square | dot
    this.maxAlpha = opts.maxAlpha != null ? opts.maxAlpha : 1;
    this.minBright = opts.minBright != null ? opts.minBright : 0.05;
    this.scrambleT = 0;                    // scramble countdown (ms)
    this.scrambleDur = 0;
    this.pulse = 0;                        // glow pulse 0..1
    this.t = 0;
    this.running = false;
    this._raf = null;
    this._last = 0;
    this._resize = this._resize.bind(this);
    this._frame = this._frame.bind(this);
    this._resize();
    window.addEventListener('resize', this._resize);
  }

  GridField.prototype._resize = function () {
    var c = this.canvas;
    var r = c.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = w * dpr;
    c.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
    this.cols = Math.ceil(w / this.cell) + 1;
    this.rows = Math.ceil(h / this.cell) + 1;
    // per-cell static noise seed
    this._noise = new Float32Array(this.cols * this.rows);
    for (var i = 0; i < this._noise.length; i++) this._noise[i] = Math.random();
    if (!this.running) this._draw(0);
  };

  GridField.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    if (REDUCED) { this._draw(0); this.running = false; return; }
    this._raf = requestAnimationFrame(this._frame);
  };

  GridField.prototype.stop = function () {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  };

  GridField.prototype.scramble = function (durationMs) {
    this.scrambleDur = durationMs || 1100;
    this.scrambleT = this.scrambleDur;
    if (!this.running) this.start();
  };

  GridField.prototype.flash = function () { this.pulse = 1; };

  GridField.prototype._frame = function (now) {
    if (!this.running) return;
    var dt = Math.min(64, now - this._last);
    this._last = now;
    this.t += dt * 0.001 * this.speed;
    if (this.scrambleT > 0) this.scrambleT -= dt;
    if (this.pulse > 0) this.pulse = Math.max(0, this.pulse - dt * 0.0016);
    this._draw(this.t);
    this._raf = requestAnimationFrame(this._frame);
  };

  GridField.prototype._draw = function (t) {
    var ctx = this.ctx, w = this.w, h = this.h;
    ctx.clearRect(0, 0, w, h);
    var size = this.cell - this.gap;
    var a1 = 0.55, a2 = 0.32;       // band angles
    var cos1 = Math.cos(a1), sin1 = Math.sin(a1);
    var cos2 = Math.cos(a2 + 1.7), sin2 = Math.sin(a2 + 1.7);
    var br = this.base, ac = this.accent, ac2 = this.accent2;
    var scrFrac = this.scrambleDur ? this.scrambleT / this.scrambleDur : 0;
    for (var jy = 0; jy < this.rows; jy++) {
      for (var ix = 0; ix < this.cols; ix++) {
        var n = this._noise[jy * this.cols + ix];
        var phase1 = (ix * cos1 + jy * sin1) * 0.5 - t * 1.6;
        var phase2 = (ix * cos2 - jy * sin2) * 0.42 - t * 0.9;
        var b1 = Math.pow(Math.max(0, Math.sin(phase1)), 3.2);
        var b2 = Math.pow(Math.max(0, Math.sin(phase2)), 4.0);
        var inten = (b1 + b2 * 0.7) * this.density;
        // twinkle
        inten += Math.max(0, Math.sin(t * 2.2 + n * 30)) * n * 0.08;
        inten += this.pulse * (0.4 + 0.6 * n);
        // scramble: random hot cells
        var col;
        if (scrFrac > 0) {
          var rnd = Math.abs(Math.sin((ix * 12.9898 + jy * 78.233) + Math.floor(t * 60)));
          inten = rnd * scrFrac + inten * (1 - scrFrac);
          col = rnd > 0.78 ? ac2 : ac;
        } else {
          col = ac;
        }
        inten = Math.min(1, inten);
        if (inten < this.minBright) inten = this.minBright;
        var rr = br[0] + (col[0] - br[0]) * inten;
        var gg = br[1] + (col[1] - br[1]) * inten;
        var bb = br[2] + (col[2] - br[2]) * inten;
        var alpha = this.maxAlpha * (0.35 + 0.65 * inten);
        ctx.fillStyle = 'rgba(' + (rr | 0) + ',' + (gg | 0) + ',' + (bb | 0) + ',' + alpha.toFixed(3) + ')';
        var px = ix * this.cell, py = jy * this.cell;
        if (this.shape === 'dot') {
          var rad = size * (0.3 + 0.2 * inten);
          ctx.beginPath();
          ctx.arc(px + size / 2, py + size / 2, rad, 0, 6.2832);
          ctx.fill();
        } else {
          ctx.fillRect(px, py, size, size);
        }
      }
    }
  };

  GridField.prototype.destroy = function () {
    this.stop();
    window.removeEventListener('resize', this._resize);
  };

  window.GridField = GridField;
})();
