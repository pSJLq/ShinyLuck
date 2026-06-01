/* ShinyLuck - interactivity */

// =============== ENTER LOBBY SMOOTH SCROLL ===============
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sl-enter-lobby]');
  if (!btn) return;
  e.preventDefault();
  const target = document.querySelector('#games') || document.querySelector('.game-grid');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// =============== BETA STICKER ON LOBBY GAME CARDS ===============
// Mirrors the full TESTING ribbon on the actual game pages but smaller -
// a corner badge on each lobby card so users see at a glance which games
// are polished (sugar, dice) and which are still rough. pointer-events:none
// keeps the card clickable through the sticker.
document.addEventListener('DOMContentLoaded', () => {
  // vault7 graduated out of beta (reels + spin fully working), so it no
  // longer gets a BETA card sticker - same tier as sugar/dice now. Roulette
  // also graduated: it is round-based, settles on-chain with real results, and
  // has its own provably-fair panel - no BETA sticker.
  const BETA_GAMES = ['crash', 'mines', 'plinko'];
  document.querySelectorAll('a.game[href*="games/"]').forEach((card) => {
    const href = (card.getAttribute('href') || '').toLowerCase();
    if (!BETA_GAMES.some((g) => href.includes('/' + g))) return;
    if (card.querySelector('.sl-beta-card-sticker')) return; // already injected
    const sticker = document.createElement('div');
    sticker.className = 'sl-beta-card-sticker';
    sticker.innerHTML = '<span>BETA</span>';
    sticker.title = 'This game is in beta - Sugar.Lab and Dice are the polished demos';
    // Anchor inside the preview wrap if present (so the sticker sits over
    // the artwork, not below the meta block). Fallback to the card itself.
    const host = card.querySelector('.game-preview-wrap') || card;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(sticker);
  });
});

// =============== CUSTOM CURSOR ===============
(function cursor() {
  const dot = document.createElement('div');
  const ring = document.createElement('div');
  dot.className = 'cursor-dot';
  ring.className = 'cursor-ring';
  document.body.appendChild(dot);
  document.body.appendChild(ring);

  let mx = window.innerWidth / 2, my = window.innerHeight / 2;
  let rx = mx, ry = my;
  let dx = mx, dy = my;

  window.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
  });

  function loop() {
    // dot tracks closely
    dx += (mx - dx) * 0.55;
    dy += (my - dy) * 0.55;
    // ring lags
    rx += (mx - rx) * 0.16;
    ry += (my - ry) * 0.16;
    dot.style.transform = `translate(${dx}px, ${dy}px) translate(-50%, -50%)`;
    ring.style.transform = `translate(${rx}px, ${ry}px) translate(-50%, -50%)`;
    requestAnimationFrame(loop);
  }
  loop();

  // hover state
  const hoverSel = 'a, button, .game, .agent-card, .tile, .stat, .flow-step, .chip, .social-tag, [data-hover]';
  document.addEventListener('mouseover', e => {
    if (e.target.closest(hoverSel)) ring.classList.add('hover');
  });
  document.addEventListener('mouseout', e => {
    if (e.target.closest(hoverSel) && !e.relatedTarget?.closest(hoverSel)) ring.classList.remove('hover');
  });
  document.addEventListener('mousedown', () => ring.classList.add('click'));
  document.addEventListener('mouseup', () => ring.classList.remove('click'));

  // hide on leave
  document.addEventListener('mouseleave', () => { dot.style.opacity = 0; ring.style.opacity = 0; });
  document.addEventListener('mouseenter', () => { dot.style.opacity = 1; ring.style.opacity = 1; });
})();

// =============== COUNT UP ===============
function countUp(el, to, opts = {}) {
  const dur = opts.duration ?? 1600;
  const start = performance.now();
  const from = opts.from ?? 0;
  const decimals = opts.decimals ?? 0;
  const prefix = opts.prefix ?? '';
  const suffix = opts.suffix ?? '';
  const sep = opts.sep ?? ' ';
  function frame(t) {
    const p = Math.min((t - start) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    const v = from + (to - from) * eased;
    let str = v.toFixed(decimals);
    // thousands sep
    const parts = str.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    el.textContent = prefix + parts.join('.') + suffix;
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-count]').forEach(el => {
    // Skip elements managed by livedata.js - they get real values, not the
    // hardcoded `data-count` placeholder. Show "-" until the live read lands.
    if (el.dataset.slRole || el.hasAttribute('data-sl')) {
      el.textContent = "-";
      return;
    }
    const target = parseFloat(el.dataset.count);
    countUp(el, target, {
      decimals: parseInt(el.dataset.decimals || '0'),
      prefix: el.dataset.prefix || '',
      suffix: el.dataset.suffix || '',
      duration: parseInt(el.dataset.duration || '1800')
    });
  });
  // Jackpot ticker removed - replaced by live casino contract address pill in hero.
});

// =============== LIVE BETS FEED ===============
const GAMES_FEED = ['CRASH', 'SLOTS', 'DICE', 'PLINKO', 'MINES', 'ROULETTE'];
const GAME_COLORS = {
  CRASH: 'var(--purple-2)', SLOTS: 'var(--cyan)', DICE: 'var(--purple-2)',
  PLINKO: 'var(--cyan)', MINES: 'var(--amber)', ROULETTE: 'var(--red)'
};
function randomAddr() {
  const hex = '0123456789abcdef';
  let h = '0x';
  for (let i = 0; i < 4; i++) h += hex[Math.floor(Math.random() * 16)];
  let t = '';
  for (let i = 0; i < 4; i++) t += hex[Math.floor(Math.random() * 16)];
  return h + '...' + t;
}
function randomBet() {
  const bases = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25];
  const b = bases[Math.floor(Math.random() * bases.length)] * (1 + Math.random());
  return b;
}
function createFeedRow() {
  const game = GAMES_FEED[Math.floor(Math.random() * GAMES_FEED.length)];
  const bet = randomBet();
  const win = Math.random() > 0.5;
  const mult = win ? (1.2 + Math.random() * 18) : 0;
  const pnl = win ? bet * (mult - 1) : -bet;
  const tr = document.createElement('tr');
  tr.className = 'feed-new';
  tr.innerHTML = `
    <td class="game-name" style="color:${GAME_COLORS[game]}">${game}</td>
    <td class="dim">${randomAddr()}</td>
    <td>${bet.toFixed(3)} STT</td>
    <td class="dim">${mult ? mult.toFixed(2) + 'x' : '-'}</td>
    <td class="${win ? 'win' : 'lose'}">${win ? '+' : ''}${pnl.toFixed(3)} STT</td>
  `;
  return tr;
}
// Live feed is populated by frontend/lib/livedata.js from real BetSettled
// events. The createFeedRow / random-address generator above is dead code,
// kept only because some pages still import app.js - but it is never called.

// =============== AGENT ACTIVITY BARS ===============
// Was random eye-candy. Now driven by lib/agent-activity.js which pulls
// real on-chain events (HM ReactiveBetSettledHandled / ReactiveHourlyTick /
// RtpAnalysisRequested / RtpAnalysisResolved, Verifier QuorumResult).
// Left in place here as a 0-fill so the bars render at all if the module
// is slow to load - agent-activity.js overwrites once cold-start completes.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.agent-bar').forEach(bar => {
    if (bar.children.length > 0) return; // already populated by the module
    const N = 28;
    bar.innerHTML = Array.from({ length: N }, () => '<span></span>').join('');
  });
});

// =============== CRASH ROUNDS (random target, restart) ===============
document.addEventListener('DOMContentLoaded', () => {
  const m = document.getElementById('crash-mult-val');
  if (!m) return;
  const card = m.closest('.game') || m.closest('.game-preview-wrap')?.parentElement;
  const linePath = card?.querySelector('.crash-preview path[stroke^="url"]');
  const areaPath = card?.querySelector('.crash-preview path[fill^="url"]');
  const dot = card?.querySelector('.crash-preview circle');

  function buildCurve(progress, target) {
    // Defensive clamp. The raf chain can occasionally hand us a `now` value
    // slightly less than `roundStart` (timestamp synthesis at frame boundary),
    // which makes `progress` negative → `Math.pow(progress, 1.6) = NaN` →
    // every SVG coord downstream NaNs. Snap to [0,1] and require a positive
    // target so the math is always defined.
    if (!Number.isFinite(progress)) progress = 0;
    progress = Math.max(0, Math.min(1, progress));
    if (!Number.isFinite(target) || target <= 0) target = 1;
    // progress 0..1 over the round; map to x in [0..380] and y from bottom
    const x = 8 + progress * 380;
    const climb = Math.pow(progress, 1.6) * (0.55 + Math.min(target/10, 0.4));
    const y = 210 - climb * 200;
    // Build a smooth path from (0,210) to (x,y)
    const cx1 = x * 0.35, cy1 = 210;
    const cx2 = x * 0.7, cy2 = 210 - climb * 80;
    return { d: `M0,210 C${cx1},${cy1} ${cx2},${cy2} ${x},${y}`, x, y, climb };
  }

  let raf, roundStart, target, dur;
  function startRound() {
    target = 1.2 + Math.random() * Math.random() * 22; // mostly small, occasional big
    dur = 1800 + target * 400; // bigger target = longer round
    roundStart = performance.now();
    if (linePath) {
      linePath.style.animation = 'none';
      areaPath.style.animation = 'none';
      // The initial CSS draw-line animation leaves stroke-dashoffset=600
      // (fully hidden) - when JS takes over and updates `d`, the path keeps
      // updating but stays invisible because of the dash gap. Reset both
      // dash attrs so the live curve is drawn as a solid line.
      linePath.removeAttribute('stroke-dasharray');
      linePath.removeAttribute('stroke-dashoffset');
      linePath.style.strokeDasharray = 'none';
      linePath.style.strokeDashoffset = '0';
    }
    tick(roundStart);
  }
  function tick(now) {
    // Same race as in games/crash.js: raf can fire with `now` slightly older
    // than `roundStart` when we just kicked off a new round. Clamp.
    if (!Number.isFinite(now) || !Number.isFinite(roundStart)) { raf = requestAnimationFrame(tick); return; }
    const elapsed = Math.max(0, now - roundStart);
    const p = Math.min(elapsed / dur, 1);
    const eased = 1 - Math.pow(1 - p, 2.2);
    const v = 1 + (target - 1) * eased;
    m.textContent = Number.isFinite(v) ? v.toFixed(2) : '1.00';
    m.style.color = v > 5 ? 'var(--cyan)' : '';
    if (linePath) {
      const c = buildCurve(p, target);
      linePath.setAttribute('d', c.d);
      areaPath.setAttribute('d', c.d + ` L${c.x},210 Z`);
      if (dot) { dot.setAttribute('cx', c.x); dot.setAttribute('cy', c.y); }
    }
    if (p < 1) raf = requestAnimationFrame(tick);
    else {
      // crash flash
      m.style.color = 'var(--red)';
      setTimeout(() => { m.style.color = ''; m.textContent = '1.00'; startRound(); }, 900);
    }
  }
  startRound();
});

// =============== SLOTS - sequential stop ===============
document.addEventListener('DOMContentLoaded', () => {
  const slots = document.querySelectorAll('.slots, .slots-big');
  slots.forEach(slot => {
    const reels = slot.querySelectorAll('.reel-strip');
    if (!reels.length) return;
    // Disable CSS animation, take over with JS
    reels.forEach(r => r.style.animation = 'none');
    const SYM = ['₿','💎','⚡','🌙'];
    const H = slot.classList.contains('slots-big') ? 107 : 73;
    // Build long strip
    reels.forEach(r => {
      const symbols = [];
      for (let i = 0; i < 40; i++) symbols.push(SYM[Math.floor(Math.random()*SYM.length)]);
      r.innerHTML = symbols.map(s => `<div class="reel-symbol">${s}</div>`).join('');
    });

    function spin() {
      const totalLen = 40 * H;
      const stops = [2400, 3200, 4000]; // sequential stop times
      reels.forEach((r, i) => {
        const finalIdx = 30 + Math.floor(Math.random()*5);
        const finalY = -finalIdx * H + H; // center on winline
        const start = performance.now();
        const dur = stops[i];
        function step(now) {
          const t = Math.min((now - start) / dur, 1);
          // ease-out cubic for deceleration
          const e = 1 - Math.pow(1 - t, 3);
          const y = finalY * e;
          r.style.transform = `translateY(${y}px)`;
          if (t < 1) requestAnimationFrame(step);
          else if (i === reels.length - 1) {
            // highlight winline symbols briefly
            reels.forEach(rl => {
              const symAtCenter = rl.children[Math.round((-finalY + H) / H) - 1];
              if (symAtCenter) symAtCenter.classList.add('win');
            });
            setTimeout(() => {
              slot.querySelectorAll('.reel-symbol.win').forEach(s => s.classList.remove('win'));
              // reset and respin
              reels.forEach(r2 => r2.style.transform = 'translateY(0)');
              spin();
            }, 1600);
          }
        }
        requestAnimationFrame(step);
      });
    }
    spin();
  });
});

// =============== MAGNETIC HOVER (subtle) ===============
document.addEventListener('mousemove', e => {
  document.querySelectorAll('.btn-primary').forEach(b => {
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 100) {
      const f = (1 - dist / 100) * 6;
      b.style.transform = `translate(${(dx / dist) * f}px, ${(dy / dist) * f}px)`;
    } else {
      b.style.transform = '';
    }
  });
});

// =============== TILT CARDS ===============
document.querySelectorAll('.game, .agent-card').forEach = null; // (placeholder, see below init)
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.game, .agent-card').forEach(card => {
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const rx = (y - 0.5) * -3;
      const ry = (x - 0.5) * 3;
      card.style.transform = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      // light glare
      card.style.background = `radial-gradient(circle at ${x*100}% ${y*100}%, rgba(139,92,246,.06), transparent 50%), var(--bg-1)`;
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
      card.style.background = '';
    });
  });
});

// =============== REVEAL ON SCROLL ===============
document.addEventListener('DOMContentLoaded', () => {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('fade-up');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('[data-reveal]').forEach(el => io.observe(el));
});
