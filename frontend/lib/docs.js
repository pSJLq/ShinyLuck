// docs.html — client-side fuzzy search over <h1>/<h2>/<h3> + their first
// paragraph. Cmd+K / Ctrl+K focuses the input; Esc clears.
//
// Indexing strategy:
//   - On boot, walk every section heading inside .docs-main; for each one
//     collect the text of nearby p/li elements until the next heading.
//   - Tokenise both the heading and the snippet; substring + word-boundary
//     match yields a score; top 8 results render in a dropdown.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => r.querySelectorAll(s);

function tokenize(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function buildIndex() {
  const main = $("[data-sl-docs-main]");
  if (!main) return [];
  const headings = main.querySelectorAll("h1, h2, h3");
  const out = [];
  headings.forEach((h) => {
    const id = h.id || "";
    if (!id) return;
    const title = h.textContent.trim();
    const titleLower = title.toLowerCase();
    // Gather snippet until the next heading.
    let snippet = "";
    let node = h.nextElementSibling;
    let count = 0;
    while (node && !/^(H1|H2|H3)$/.test(node.tagName) && count < 4) {
      snippet += " " + node.textContent;
      count++;
      node = node.nextElementSibling;
    }
    snippet = snippet.trim().replace(/\s+/g, " ").slice(0, 220);
    out.push({
      id, title, titleLower,
      snippet, snippetLower: snippet.toLowerCase(),
      titleTokens: tokenize(title),
      snippetTokens: tokenize(snippet),
    });
  });
  return out;
}

function score(entry, q) {
  const qLower = q.toLowerCase();
  const qTokens = tokenize(qLower);
  if (qTokens.length === 0) return 0;
  let s = 0;
  // Phrase match in title >> everywhere else.
  if (entry.titleLower.includes(qLower)) s += 100;
  if (entry.snippetLower.includes(qLower)) s += 30;
  for (const t of qTokens) {
    if (entry.titleTokens.includes(t)) s += 20;
    else if (entry.titleLower.includes(t)) s += 10;
    if (entry.snippetTokens.includes(t)) s += 6;
    else if (entry.snippetLower.includes(t)) s += 3;
  }
  return s;
}

function highlight(text, q) {
  if (!q) return text;
  const re = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
  return text.replace(re, '<span style="color:var(--cyan);">$1</span>');
}

let kbdIdx = -1;
let currentResults = [];

function render(results, q) {
  const root = $("[data-sl-docs-search-results]");
  if (!root) return;
  if (!q) { root.style.display = "none"; return; }
  root.style.display = "block";
  if (results.length === 0) {
    root.innerHTML = `<div class="empty">No matches for "${q}"</div>`;
    return;
  }
  root.innerHTML = "";
  results.forEach((r, i) => {
    const a = document.createElement("a");
    a.href = "#" + r.id;
    a.innerHTML = `<div class="h">${highlight(r.title, q)}</div><div class="snip">${highlight(r.snippet, q)}</div>`;
    if (i === kbdIdx) a.classList.add("kbd-focus");
    a.addEventListener("click", () => {
      root.style.display = "none";
      $("[data-sl-docs-search-input]").value = "";
    });
    root.appendChild(a);
  });
}

function runSearch(q) {
  const idx = buildIndex();
  const ranked = idx.map((e) => ({ e, s: score(e, q) }))
                    .filter(({ s }) => s > 0)
                    .sort((a, b) => b.s - a.s)
                    .slice(0, 8)
                    .map(({ e }) => e);
  kbdIdx = ranked.length ? 0 : -1;
  currentResults = ranked;
  render(ranked, q);
}

document.addEventListener("DOMContentLoaded", () => {
  const input = $("[data-sl-docs-search-input]");
  const root  = $("[data-sl-docs-search-results]");
  if (!input || !root) return;

  input.addEventListener("input", () => runSearch(input.value.trim()));
  input.addEventListener("focus", () => { if (input.value.trim()) runSearch(input.value.trim()); });
  input.addEventListener("blur", () => setTimeout(() => { root.style.display = "none"; }, 150));

  input.addEventListener("keydown", (e) => {
    if (currentResults.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      kbdIdx = (kbdIdx + 1) % currentResults.length;
      render(currentResults, input.value.trim());
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      kbdIdx = (kbdIdx - 1 + currentResults.length) % currentResults.length;
      render(currentResults, input.value.trim());
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = currentResults[kbdIdx];
      if (picked) {
        location.hash = "#" + picked.id;
        root.style.display = "none";
        input.value = "";
      }
    } else if (e.key === "Escape") {
      input.value = ""; root.style.display = "none";
    }
  });

  // Cmd+K / Ctrl+K → focus search.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  // Side-nav active-link tracking on scroll.
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const id = entry.target.id;
      $$(".ds-nav a, .docs-toc a").forEach((a) => {
        a.classList.toggle("on", a.getAttribute("href") === "#" + id);
      });
    });
  }, { rootMargin: "-40% 0px -55% 0px" });
  $$("[data-sl-docs-main] h2[id]").forEach((h) => obs.observe(h));
});
