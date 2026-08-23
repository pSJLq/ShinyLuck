/* ShinyLuck InfoFi - Somnia X-mindshare treemap.
 * Reads /infofi-data.json, refreshed daily by the x-oracle collector
 * (infofi/collect.py) - the same X pipeline that resolves prediction markets.
 *
 * Two populations share the board and they are NOT scored on the same surface:
 * a project earns from all of its own posts, a community voice only from
 * ecosystem-tagged activity. Shares are global, so the numbers stay comparable
 * across a view switch - only which tiles are drawn changes.
 */

/* The snapshot is produced by a script in a different repo, so a field can go
 * missing across a schema change or an older file left on disk. Coerce once at
 * the edge rather than trusting every key: without this, one absent counter
 * renders "NaN" into the table and "undefined" into a tile. */
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const fmtN = (v) => { const n = num(v); return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* Colour encodes the GROUP and nothing else - never the rank. The previous
 * build alternated two alphas by rank index, which made neighbouring tiles of
 * the same group look like different things and turned the board into stripes.
 *
 * These two steps are not a taste call. Measured in OKLab (x100) against this
 * page's #0A0A0B surface, the old gold/green pair separated by only dE 13.0 to
 * normal vision and dE 5.0 under protanopia - below the dE 15 / dE 8 floors,
 * i.e. genuinely hard to tell apart. This pair clears both with room:
 * dE 19.4 normal, 17.6 protan, 19.0 tritan. --gold-dark is the design system's
 * own step; the teal is the first non-gold hue on the site, and it is here
 * because no step on the gold-to-tan axis can separate from gold by construction. */
const KIND = {
  project: { c: "#A6822F", label: "Ecosystem project", tag: "ECOSYSTEM" },
  voice: { c: "#2A9BB5", label: "Community voice", tag: "VOICE" },
};
const kindOf = (p) => KIND[p.kind] || KIND.voice;

// squarified treemap (Bruls et al.)
function squarify(items, x, y, w, h, out) {
  if (!items.length) return;
  if (items.length === 1) { out.push({ ...items[0], x, y, w, h }); return; }
  const total = items.reduce((s, it) => s + it.v, 0);
  const scale = (w * h) / total;
  let row = [], rest = items.slice();
  const worst = (r, side) => {
    const s = r.reduce((a, b) => a + b.v * scale, 0);
    let mx = 0;
    for (const it of r) {
      const a = it.v * scale;
      mx = Math.max(mx, Math.max((side * side * a) / (s * s), (s * s) / (side * side * a)));
    }
    return mx;
  };
  const side = Math.min(w, h);
  while (rest.length) {
    const next = [...row, rest[0]];
    if (row.length && worst(next, side) > worst(row, side)) break;
    row = next; rest.shift();
  }
  const rowArea = row.reduce((a, b) => a + b.v * scale, 0);
  if (w >= h) {
    const rw = rowArea / h;
    let cy = y;
    for (const r of row) { const rh = (r.v * scale) / rw; out.push({ ...r, x, y: cy, w: rw, h: rh }); cy += rh; }
    squarify(rest, x + rw, y, w - rw, h, out);
  } else {
    const rh = rowArea / w;
    let cx = x;
    for (const r of row) { const rw = (r.v * scale) / rh; out.push({ ...r, x: cx, y, w: rw, h: rh }); cx += rw; }
    squarify(rest, x, y + rh, w, h - rh, out);
  }
}

const VIEWS = {
  all: { label: "Everyone", keep: () => true },
  project: { label: "Projects", keep: (p) => p.kind === "project" },
  voice: { label: "Users", keep: (p) => p.kind === "voice" },
};

let DATA = null;
let VIEW = "all";
let TILES = [];

/* The avatar is the tile's texture. It is mirrored onto our own domain by the
 * collector, so the page never hotlinks pbs.twimg.com and never announces a
 * visitor to X. Accounts without one get a monogram in the group colour -
 * deliberately NOT a per-account generated hue, which would spend the identity
 * channel on decoration and undermine the two-colour encoding above. */
function tileBody(t, id) {
  const p = t.p, k = kindOf(p);
  const r = Math.min(10, t.w / 2, t.h / 2);
  const initial = esc((p.name || p.handle || "?").trim().charAt(0).toUpperCase());
  const art = p.avatar
    ? `<image href="${esc(p.avatar)}" x="0" y="0" width="${t.w}" height="${t.h}"
              preserveAspectRatio="xMidYMid slice" class="tl-av" />`
    : `<rect width="${t.w}" height="${t.h}" fill="${k.c}" fill-opacity=".16"/>
       <text class="tl-mono" x="${t.w / 2}" y="${t.h / 2}" fill="${k.c}"
             font-size="${Math.min(t.w, t.h) * 0.44}">${initial}</text>`;
  // Three veils stack over the photo: its own opacity, a group tint, and the
  // bottom scrim that makes the label readable. Kept deliberately light - the
  // whole point of the picture is that the board stops looking like flat
  // swatches, and the group still reads from the 2px border, the legend and the
  // written badge, so the tint does not have to shout.
  return `<clipPath id="${id}"><rect width="${t.w}" height="${t.h}" rx="${r}"/></clipPath>
    <g clip-path="url(#${id})">
      ${art}
      <rect width="${t.w}" height="${t.h}" fill="${k.c}" fill-opacity="${p.avatar ? ".18" : "0"}"/>
      <rect width="${t.w}" height="${t.h}" fill="url(#ifScrim)"/>
    </g>
    <rect width="${t.w}" height="${t.h}" rx="${r}" fill="none"
          stroke="${k.c}" stroke-opacity=".9" stroke-width="2"/>`;
}

function drawTreemap() {
  const svg = document.getElementById("tmap");
  const rows = DATA.projects || [];
  const active = rows
    .filter((p) => p.score > 0 && VIEWS[VIEW].keep(p))
    .sort((a, b) => b.score - a.score);

  const W = svg.clientWidth || 1100;
  // px only - a vh/dvh height inside this page would feed the iframe height
  // sync in the shell and grow the frame a little on every tick.
  const H = Math.round(Math.max(320, Math.min(520, W * 0.42)));
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  if (!active.length) {
    svg.innerHTML = "";
    document.getElementById("ifContext").textContent = "No account in this group has any measured signal in the window.";
    TILES = [];
    return;
  }

  TILES = [];
  squarify(active.map((p, i) => ({ v: Math.max(p.score, 0.001), p, rank: i + 1 })), 0, 0, W, H, TILES);

  // Inset every tile so neighbours are separated by a strip of page background
  // rather than butting their borders together. The old build got this from a
  // 3px background-coloured stroke, which no longer works now that each tile
  // carries a coloured border of its own.
  const GAP = 3;
  for (const t of TILES) {
    if (t.w > GAP * 2 && t.h > GAP * 2) {
      t.x += GAP / 2; t.y += GAP / 2; t.w -= GAP; t.h -= GAP;
    }
  }

  const defs = `<defs><linearGradient id="ifScrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity=".04"/>
      <stop offset="50%" stop-color="#000" stop-opacity=".30"/>
      <stop offset="100%" stop-color="#000" stop-opacity=".74"/>
    </linearGradient></defs>`;

  svg.innerHTML = defs + TILES.map((t, ti) => {
    const p = t.p;
    // Every tile keeps a readable label; detail drops out with the box, but a
    // handle is never omitted entirely.
    const big = t.w > 150 && t.h > 92, mid = t.w > 96 && t.h > 56;
    const small = !mid && t.w > 46 && t.h > 26;
    const fs = big ? 17 : mid ? 13 : small ? 9.5 : 7.5;
    const pad = big || mid ? 12 : 5;
    const label = big || mid
      ? (p.name ? esc(p.name).slice(0, big ? 18 : 11) : "@" + esc(p.handle))
      : esc(p.handle).slice(0, Math.max(3, Math.floor(t.w / (fs * 0.6))));
    const showShare = big || mid || (small && t.h > 42);
    return `<g class="tile" data-i="${ti}" transform="translate(${t.x},${t.y})">
      ${tileBody(t, `ifc${ti}`)}
      <text class="tl-name" x="${pad}" y="${big ? 26 : mid ? 22 : fs + 4}" font-size="${fs}">${label}</text>
      ${showShare ? `<text class="tl-share" x="${pad}" y="${big ? 48 : mid ? 40 : fs * 2 + 6}" font-size="${big ? 13 : mid ? 11 : 8.5}">${num(p.share).toFixed(big || mid ? 2 : 1)}%</text>` : ""}
      ${t.rank <= 3 && mid ? `<text class="tl-rank" x="${t.w - 14}" y="27" text-anchor="end" font-size="${big ? 19 : 14}">${t.rank}</text>` : ""}
      ${big ? `<text class="tl-kind" x="12" y="${t.h - 12}">${kindOf(p).tag} · ${num(p.posts)} posts · ${fmtN(p.likes)} likes</text>` : ""}
    </g>`;
  }).join("");

  wireTips(svg);
}

function wireTips(svg) {
  const tip = document.getElementById("ifTip");
  const hide = () => { tip.style.display = "none"; };
  svg.querySelectorAll(".tile").forEach((el) => {
    const show = (cx, cy) => {
      const t = TILES[+el.dataset.i];
      if (!t) return;
      const p = t.p;
      tip.style.display = "block";
      tip.style.left = Math.min(cx + 14, window.innerWidth - 250) + "px";
      tip.style.top = cy + 14 + "px";
      const voiceRows = p.kind === "voice"
        ? `<div class="row"><span>Own tagged comments</span><span>${num(p.comments)}</span></div>` : "";
      const d = Number.isFinite(+p.delta) ? +p.delta : null;
      const delta = d == null ? "" :
        `<div class="row"><span>Change vs previous day</span><span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${d.toFixed(2)}%</span></div>`;
      tip.innerHTML = `<b>${esc(p.name || p.handle)}</b> <span class="kbadge ${p.kind}">${p.kind}</span>
        <div class="row"><span>@${esc(p.handle)}</span><span>${fmtN(p.followers)} followers</span></div>
        <div class="row"><span>${p.kind === "voice" ? "Tagged posts" : "Posts"} (${DATA.window_hours}h)</span><span>${num(p.posts)}</span></div>
        ${voiceRows}
        <div class="row"><span>Likes</span><span>${fmtN(p.likes)}</span></div>
        <div class="row"><span>Reposts + quotes</span><span>${fmtN(num(p.retweets) + num(p.quotes))}</span></div>
        <div class="row"><span>Replies received</span><span>${fmtN(p.replies)}</span></div>
        <div class="row"><span>Bookmarks</span><span>${fmtN(p.bookmarks)}</span></div>
        <div class="row"><span>Views</span><span>${fmtN(p.views)}</span></div>
        <div class="row"><span>Mindshare</span><span>${num(p.share).toFixed(2)}%</span></div>
        ${delta}`;
    };
    el.addEventListener("mousemove", (ev) => show(ev.clientX, ev.clientY));
    el.addEventListener("mouseleave", hide);
    // Touch has no hover; a tap should still be able to read the numbers.
    el.addEventListener("click", (ev) => show(ev.clientX, ev.clientY));
  });
  svg.addEventListener("mouseleave", hide);
}

const rowHtml = (p, i) => `<tr>
  <td class="acc" data-no-i18n>${i + 1}. ${esc(p.name || p.handle)}<span class="h">@${esc(p.handle)}</span></td>
  <td>${num(p.posts)}</td><td>${p.kind === "voice" ? num(p.comments) : "-"}</td>
  <td>${fmtN(p.likes)}</td><td>${fmtN(num(p.retweets) + num(p.quotes))}</td>
  <td>${fmtN(p.replies)}</td><td>${fmtN(p.bookmarks)}</td><td>${fmtN(p.views)}</td>
  <td>${num(p.score).toFixed(0)}</td><td>${num(p.share).toFixed(2)}%</td>
</tr>`;

function drawBoards() {
  const rows = DATA.projects || [];
  const board = (kind) => rows.filter((p) => p.kind === kind).sort((a, b) => b.score - a.score);
  const projects = board("project"), voices = board("voice");

  // The table is the accessible twin of the chart, so it follows the same
  // filter: what you switched to is what you can read.
  const wantP = VIEW !== "voice" && projects.length;
  const wantV = VIEW !== "project" && voices.length;
  document.getElementById("ifProjWrap").style.display = wantP ? "" : "none";
  document.getElementById("ifVoiceWrap").style.display = wantV ? "" : "none";
  if (wantP) document.getElementById("ifProjRows").innerHTML = projects.map(rowHtml).join("");
  if (wantV) document.getElementById("ifVoiceRows").innerHTML = voices.map(rowHtml).join("");
  document.getElementById("ifProjCount").textContent =
    `${projects.length} accounts · ${projects.reduce((s, p) => s + num(p.share), 0).toFixed(1)}% of mindshare`;
  document.getElementById("ifVoiceCount").textContent =
    `${voices.length} accounts · ${voices.reduce((s, p) => s + num(p.share), 0).toFixed(1)}% of mindshare`;
}

/* The treemap always fills its box, so a filtered view LOOKS like the whole pie
 * even when it is a sixteenth of one. This line is what keeps that honest. */
function drawContext() {
  const rows = (DATA.projects || []).filter((p) => p.score > 0);
  const shown = rows.filter(VIEWS[VIEW].keep);
  const sum = shown.reduce((s, p) => s + num(p.share), 0);
  const el = document.getElementById("ifContext");
  el.textContent = VIEW === "all"
    ? `${shown.length} accounts with measured signal · the full board`
    : `${shown.length} ${VIEW === "project" ? "ecosystem accounts" : "community voices"} · ` +
      `${sum.toFixed(1)}% of total mindshare · tiles are sized within this group`;
}

function render() {
  drawContext();
  drawTreemap();
  drawBoards();
}

function wireSeg() {
  document.getElementById("ifSeg").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-view]");
    if (!btn || !VIEWS[btn.dataset.view] || btn.dataset.view === VIEW) return;
    VIEW = btn.dataset.view;
    document.querySelectorAll("#ifSeg [data-view]").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.getElementById("ifTip").style.display = "none";
    render();
  });
}

async function main() {
  try {
    DATA = await (await fetch("/infofi-data.json?" + Date.now())).json();
  } catch (e) {
    document.getElementById("ifMeta").textContent = "snapshot unavailable";
    document.getElementById("ifContext").textContent = "";
    document.getElementById("tmap").outerHTML =
      '<div class="if-empty">No snapshot yet - the daily collector has not published one.</div>';
    document.querySelector(".if-controls").style.display = "none";
    return;
  }
  const rows = DATA.projects || [];
  document.getElementById("ifMeta").textContent =
    `${DATA.window_hours}h window · ${rows.length} accounts · updated ${new Date(DATA.generated).toLocaleString()}`;

  wireSeg();
  render();

  // Tiles are laid out from the measured pixel width, so a resize has to relay
  // them out; boards and context are cheap enough to redo with them.
  let t = null;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(render, 150); });

  const tagsLine = (DATA.tags || []).map((x) => "@" + x).join(", ");
  document.getElementById("ifNote").innerHTML =
    `Engagement = ${esc(DATA.formula || "")}, where "replies" means replies RECEIVED under the content. ` +
    `Gold tiles are curated ecosystem accounts, measured on all their own posts. ` +
    `Teal tiles are community voices, scoped strictly to the ecosystem context tags (${esc(tagsLine)}): ` +
    `their tagged posts count at full weight, their own tagged comments at half weight. ` +
    `Comments outside the tag context are ignored on purpose. Shares are always a slice of the WHOLE board, ` +
    `so switching views never inflates anyone's number. ` +
    `Collected daily by the same x-oracle pipeline that resolves ShinyLuck prediction markets.`;
}

main();
