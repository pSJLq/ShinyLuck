// One-off: copy the design's static marketing/legal pages into the live
// frontend (frontend/poker/) with all design links repointed to real targets.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "ShinyPokerDesign", "ShinyPokerDesign2");
const DST = path.join(__dirname, "..", "frontend", "poker");
const CASINO = "https://shiny-luck.vercel.app/";

// design filename -> live filename
const PAGES = {
  "ShinyPoker Landing.html": "index.html",
  "ShinyPoker Provably-Fair.html": "provably-fair.html",
  "ShinyPoker Terms.html": "terms.html",
  "ShinyPoker Privacy.html": "privacy.html",
  "ShinyPoker Responsible-Gaming.html": "responsible.html",
};

// design link -> real target
const LINKS = [
  ["ShinyPoker Landing.html", "index.html"],
  ["ShinyPoker Lobby.html", "lobby.html"],
  ["ShinyPoker Onboarding.html", "table.html?t=0"],
  ["ShinyPoker Provably-Fair.html", "provably-fair.html"],
  ["ShinyPoker Terms.html", "terms.html"],
  ["ShinyPoker Privacy.html", "privacy.html"],
  ["ShinyPoker Responsible-Gaming.html", "responsible.html"],
  ["ShinyPoker Clubs.html", "lobby.html"],
  ["ShinyPoker Cashier.html", "lobby.html"],
];

function rewrite(s) {
  for (const [from, to] of LINKS) s = s.split(from).join(to);
  // casino switcher / family / footer links → the live casino
  s = s.split('class="casino" href="#"').join('class="casino" href="' + CASINO + '"');
  s = s.split('href="#">{s} ShinyLuck Casino').join('href="' + CASINO + '">{s} ShinyLuck Casino');
  s = s.split('href="#">ShinyLuck Casino').join('href="' + CASINO + '">ShinyLuck Casino');
  // testnet, not mainnet (factual for this build)
  s = s.split("Somnia Mainnet").join("Somnia Testnet");
  s = s.split("on Somnia Mainnet").join("on Somnia Testnet");
  s = s.split("Live on Somnia Testnet · zkShuffle").join("Live on Somnia Testnet · provably fair");
  return s;
}

// shared chrome
for (const f of ["marketing.css"]) fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
fs.writeFileSync(path.join(DST, "marketing.js"), rewrite(fs.readFileSync(path.join(SRC, "marketing.js"), "utf8")));

// pages
for (const [src, dst] of Object.entries(PAGES)) {
  fs.writeFileSync(path.join(DST, dst), rewrite(fs.readFileSync(path.join(SRC, src), "utf8")));
  console.log("wrote frontend/poker/" + dst);
}
console.log("wrote frontend/poker/marketing.js + marketing.css");
