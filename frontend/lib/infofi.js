/* ShinyLuck InfoFi - Somnia X-mindshare treemap.
 * Reads /infofi-data.json, refreshed daily by the x-oracle collector
 * (infofi/collect.py) - the same X pipeline that resolves prediction markets.
 * Gold tiles = curated ecosystem accounts (all their own posts).
 * Green tiles = community voices, scored ONLY on ecosystem-tagged activity. */

const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// low-alpha fills so the text tokens stay readable on top
const FILL = {
  project: ["rgba(201,133,0,.34)", "rgba(201,133,0,.22)"],
  voice: ["rgba(25,158,112,.30)", "rgba(25,158,112,.18)"],
};
const STROKE = { project: "#C98500", voice: "#199E70" };

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

async function main() {
  let data;
  try {
    data = await (await fetch("/infofi-data.json?" + Date.now())).json();
  } catch (e) {
    document.getElementById("ifMeta").textContent = "snapshot unavailable";
    document.getElementById("tmap").outerHTML = '<div class="if-empty">No snapshot yet - the daily collector has not published one.</div>';
    return;
  }
  const rows = data.projects || [];
  // biggest first: squarified treemaps only read top-left -> bottom-right when
  // the input is sorted descending (this is what Kaito's board does too)
  const active = rows.filter((p) => p.score > 0).slice().sort((a, b) => b.score - a.score);
  document.getElementById("ifMeta").textContent =
    `${data.window_hours}h window · ${rows.length} accounts · updated ${new Date(data.generated).toLocaleString()}`;

  // ---- treemap (only accounts with signal have area) ----
  const svg = document.getElementById("tmap");
  const W = svg.clientWidth || 1100, H = +svg.getAttribute("height");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const tiles = [];
  squarify(active.map((p, i) => ({ v: Math.max(p.score, 0.001), p, rank: i + 1 })), 0, 0, W, H, tiles);

  const tip = document.getElementById("ifTip");
  svg.innerHTML = tiles.map((t, ti) => {
    const p = t.p;
    const fill = (FILL[p.kind] || FILL.voice)[t.rank % 2];
    // Every tile gets a readable label - the font and the amount of detail
    // scale down with the box, but a handle is never dropped entirely.
    const big = t.w > 150 && t.h > 92, mid = t.w > 96 && t.h > 56;
    const small = !mid && t.w > 46 && t.h > 26;
    const fs = big ? 17 : mid ? 13 : small ? 9.5 : 7.5;
    const pad = big || mid ? 12 : 5;
    const label = big || mid
      ? (p.name ? esc(p.name).slice(0, big ? 18 : 11) : "@" + esc(p.handle))
      : esc(p.handle).slice(0, Math.max(3, Math.floor(t.w / (fs * 0.6))));
    const showShare = big || mid || (small && t.h > 42);
    return `<g class="tile" data-i="${ti}" transform="translate(${t.x},${t.y})">
      <rect width="${t.w}" height="${t.h}" fill="${fill}" stroke="${STROKE[p.kind] || STROKE.voice}" stroke-opacity=".35"/>
      <text class="tl-name" x="${pad}" y="${big ? 26 : mid ? 22 : fs + 4}" font-size="${fs}">${label}</text>
      ${showShare ? `<text class="tl-share" x="${pad}" y="${big ? 48 : mid ? 40 : fs * 2 + 6}" font-size="${big ? 13 : mid ? 11 : 8.5}">${p.share.toFixed(big || mid ? 2 : 1)}%</text>` : ""}
      ${t.rank <= 3 && mid ? `<text class="tl-rank" x="${t.w - 14}" y="27" text-anchor="end" font-size="${big ? 19 : 14}">${t.rank}</text>` : ""}
      ${big ? `<text class="tl-kind" x="12" y="${t.h - 12}">${p.kind === "project" ? "ECOSYSTEM" : "VOICE"} · ${p.posts} posts · ${fmtN(p.likes)} likes</text>` : ""}
    </g>`;
  }).join("");

  svg.querySelectorAll(".tile").forEach((el) => {
    el.addEventListener("mousemove", (ev) => {
      const p = tiles[+el.dataset.i].p;
      tip.style.display = "block";
      tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - 240) + "px";
      tip.style.top = ev.clientY + 14 + "px";
      const voiceRows = p.kind === "voice"
        ? `<div class="row"><span>Own tagged comments</span><span>${p.comments}</span></div>` : "";
      tip.innerHTML = `<b>${esc(p.name || p.handle)}</b> <span class="kbadge ${p.kind}">${p.kind}</span>
        <div class="row"><span>@${esc(p.handle)}</span><span>${fmtN(p.followers)} followers</span></div>
        <div class="row"><span>${p.kind === "voice" ? "Tagged posts" : "Posts"} (${data.window_hours}h)</span><span>${p.posts}</span></div>
        ${voiceRows}
        <div class="row"><span>Likes</span><span>${fmtN(p.likes)}</span></div>
        <div class="row"><span>Reposts + quotes</span><span>${fmtN(p.retweets + p.quotes)}</span></div>
        <div class="row"><span>Replies received</span><span>${fmtN(p.replies)}</span></div>
        <div class="row"><span>Bookmarks</span><span>${fmtN(p.bookmarks)}</span></div>
        <div class="row"><span>Views</span><span>${fmtN(p.views)}</span></div>
        <div class="row"><span>Mindshare</span><span>${p.share.toFixed(2)}%</span></div>`;
    });
    el.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  });

  // ---- two leaderboards: ecosystem projects and community voices ----
  // They are scored on different surfaces (a project on ALL its posts, a voice
  // only on tagged activity), so ranking them in one table would be apples to
  // oranges. Shares stay global, so the two boards remain comparable.
  const board = (kind) => rows.filter((p) => p.kind === kind).sort((a, b) => b.score - a.score);
  const rowHtml = (p, i) => `<tr>
    <td class="acc">${i + 1}. ${esc(p.name || p.handle)}<span class="h">@${esc(p.handle)}</span></td>
    <td>${p.posts}</td><td>${p.kind === "voice" ? p.comments : "-"}</td>
    <td>${fmtN(p.likes)}</td><td>${fmtN(p.retweets + p.quotes)}</td>
    <td>${fmtN(p.replies)}</td><td>${fmtN(p.bookmarks)}</td><td>${fmtN(p.views)}</td>
    <td>${p.score.toFixed(0)}</td><td>${p.share.toFixed(2)}%</td>
  </tr>`;
  const projects = board("project"), voices = board("voice");
  document.getElementById("ifProjWrap").style.display = projects.length ? "" : "none";
  document.getElementById("ifVoiceWrap").style.display = voices.length ? "" : "none";
  document.getElementById("ifProjRows").innerHTML = projects.map(rowHtml).join("");
  document.getElementById("ifVoiceRows").innerHTML = voices.map(rowHtml).join("");
  document.getElementById("ifProjCount").textContent = `${projects.length} accounts · ${projects.reduce((s, p) => s + p.share, 0).toFixed(1)}% of mindshare`;
  document.getElementById("ifVoiceCount").textContent = `${voices.length} accounts · ${voices.reduce((s, p) => s + p.share, 0).toFixed(1)}% of mindshare`;

  const tagsLine = (data.tags || []).map((t) => "@" + t).join(", ");
  document.getElementById("ifNote").innerHTML =
    `Engagement = ${esc(data.formula || "")}, where "replies" means replies RECEIVED under the content. ` +
    `Gold tiles are curated ecosystem accounts, measured on all their own posts. ` +
    `Green tiles are community voices, scoped strictly to the ecosystem context tags (${esc(tagsLine)}): ` +
    `their tagged posts count at full weight, their own tagged comments at half weight. ` +
    `Comments outside the tag context are ignored on purpose. Collected daily by the same x-oracle pipeline that resolves ShinyLuck prediction markets.`;
}

main();
