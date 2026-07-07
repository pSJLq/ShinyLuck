/* Playing cards — suit glyphs + Card component. Exports to window. */
const SUIT_PATHS = {
  s: "M12 2C12 2 4 8.5 4 14.2 4 17.4 6.4 19.6 9.2 19.6 10.3 19.6 11.2 19.2 12 18.5 12.8 19.2 13.7 19.6 14.8 19.6 17.6 19.6 20 17.4 20 14.2 20 8.5 12 2 12 2ZM10.6 18.5C10.6 20.4 9.8 21.6 8.5 22.4L15.5 22.4C14.2 21.6 13.4 20.4 13.4 18.5Z",
  h: "M12 21.4C12 21.4 2.5 14.9 2.5 8.6 2.5 5.5 4.9 3.2 7.8 3.2 9.6 3.2 11.2 4.2 12 5.6 12.8 4.2 14.4 3.2 16.2 3.2 19.1 3.2 21.5 5.5 21.5 8.6 21.5 14.9 12 21.4 12 21.4Z",
  d: "M12 1.5L21 12 12 22.5 3 12Z",
  c: "M12 2.2C9.7 2.2 7.9 4 7.9 6.3 7.9 7 8 7.5 8.3 8.1 6.6 7.5 4.5 8.3 3.7 10.1 2.9 12.2 3.9 14.6 6 15.4 7.3 15.9 8.7 15.7 9.8 15L9.8 15.2C9.8 17.1 9 18.6 7.7 19.4L16.3 19.4C15 18.6 14.2 17.1 14.2 15.2L14.2 15C15.3 15.7 16.7 15.9 18 15.4 20.1 14.6 21.1 12.2 20.3 10.1 19.5 8.3 17.4 7.5 15.7 8.1 16 7.5 16.1 7 16.1 6.3 16.1 4 14.3 2.2 12 2.2Z"
};
const SUIT_NAME = { s: "spade", h: "heart", d: "diamond", c: "club" };
const RANK_LABEL = { T: "10" };

function Suit({ s, size }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={SUIT_PATHS[s]} fill="currentColor" />
    </svg>
  );
}

/* card string like "As", "Kh", "Td", "9c"  — or {back:true} */
function Card({ c, back, folded, dealing, className, style, delay }) {
  if (back || !c) {
    return (
      <div className={"card back " + (className || "")} style={style}>
        <div className="bk"><SparkMark className="mk" /></div>
      </div>
    );
  }
  const rank = c[0];
  const suit = c[1];
  const cls = ["card", "s-" + SUIT_NAME[suit]];
  if (folded) cls.push("folded");
  if (dealing) cls.push("dealing");
  if (className) cls.push(className);
  const st = Object.assign({}, style);
  if (dealing && delay != null) st.animationDelay = delay + "ms";
  return (
    <div className={cls.join(" ")} style={st}>
      <span className="rank">{RANK_LABEL[rank] || rank}</span>
      <span className="center-suit"><Suit s={suit} size={28} /></span>
      <span className="pip"><Suit s={suit} size={11} /></span>
    </div>
  );
}

/* Deterministic avatar look: a warm two-tone gradient + tilt derived from the
   player's name/address — kills the "letter in a gray box" placeholder feel. */
function avatarColors(seed) {
  let h = 0; const s = String(seed || "?").toLowerCase();
  for (let i = 0; i < s.length; i++) h = ((h * 31 + s.charCodeAt(i)) & 0xffffffff) >>> 0;
  const PAL = [
    ["#d9ab4a", "#7c5117"], ["#e2793f", "#6e2a12"], ["#c8963a", "#3f2a0e"], ["#b8574f", "#521c1c"],
    ["#7a9a4e", "#2a4319"], ["#4f8f8b", "#1b3d3b"], ["#9a6ad0", "#37215a"], ["#c0576f", "#4e1c2c"],
    ["#5e82c8", "#1f3153"], ["#b0b46a", "#44461e"], ["#cf8f5c", "#5a3416"], ["#6aa9a0", "#24443f"],
  ];
  const p = PAL[h % PAL.length];
  return { a: p[0], b: p[1], rot: (h >>> 4) % 360 };
}

/* Minimal sparkle mark (card backs, small accents) — single-path currentColor. */
function SparkMark({ className, style }) {
  return (
    <svg className={className} style={style} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path d="M 32 3 Q 36.5 23 47 32 Q 36.5 41 32 61 Q 27.5 41 17 32 Q 27.5 23 32 3 Z" fill="currentColor" transform="rotate(26 32 32)" />
    </svg>
  );
}

/* ShinyPoker brand mark — the "shiny card" sparkle from ShinyPokerDesign/Logo:
   a card bent into a four-point star, white core, gold rim, sparkle dust. */
function SparkLogo({ size = 22 }) {
  const star = (x, y, r) => `M ${x} ${y - r} L ${x + r * 0.28} ${y - r * 0.28} L ${x + r} ${y} L ${x + r * 0.28} ${y + r * 0.28} L ${x} ${y + r} L ${x - r * 0.28} ${y + r * 0.28} L ${x - r} ${y} L ${x - r * 0.28} ${y - r * 0.28} Z`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ display: "block" }}>
      <defs>
        <radialGradient id="spkCore" cx="50%" cy="44%" r="62%">
          <stop offset="0%" stopColor="#fffef8" />
          <stop offset="55%" stopColor="#fff6dd" />
          <stop offset="100%" stopColor="#f0d998" />
        </radialGradient>
        <filter id="spkGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
      </defs>
      <g transform="rotate(26 32 32)">
        <path d="M 32 3 Q 36.5 23 47 32 Q 36.5 41 32 61 Q 27.5 41 17 32 Q 27.5 23 32 3 Z"
          fill="#e8c15a" opacity="0.6" filter="url(#spkGlow)" />
        <path d="M 32 3 Q 36.5 23 47 32 Q 36.5 41 32 61 Q 27.5 41 17 32 Q 27.5 23 32 3 Z"
          fill="url(#spkCore)" stroke="#d9ab4a" strokeWidth="1.4" strokeLinejoin="round" />
      </g>
      <path d={star(13, 18, 3)} fill="#f2d78a" opacity="0.95" />
      <path d={star(52, 13, 2.2)} fill="#f2d78a" opacity="0.8" />
      <path d={star(50, 51, 2.6)} fill="#f2d78a" opacity="0.9" />
      <path d={star(12, 47, 1.8)} fill="#f2d78a" opacity="0.7" />
    </svg>
  );
}

/* {s} brace mark from Somnia brand (two braces + mono s) */
function BraceMark({ className, style }) {
  return (
    <svg className={className} style={style} viewBox="0 0 514.666 390.309" fill="none" aria-hidden="true">
      <path d="M 0 180.699 L 18.07 180.699 C 23.19 180.699 27.707 179.644 31.622 177.536 C 35.537 175.127 38.7 172.115 41.109 168.501 C 43.819 164.586 45.777 160.37 46.982 155.852 C 48.487 151.034 49.24 146.215 49.24 141.397 L 49.24 68.665 C 49.24 57.522 50.294 47.735 52.403 39.302 C 54.812 30.869 58.727 23.792 64.148 18.07 C 69.569 12.047 76.797 7.529 85.832 4.517 C 95.168 1.506 106.763 0 120.616 0 L 157.208 0 L 157.208 29.364 L 118.809 29.364 C 106.16 29.364 97.125 32.225 91.704 37.947 C 86.585 43.669 84.025 54.059 84.025 69.117 L 84.025 131.458 C 84.025 151.636 81.013 166.544 74.99 176.181 C 68.967 185.517 62.04 191.842 54.21 195.154 C 62.04 198.768 68.967 205.545 74.99 215.483 C 81.013 225.421 84.025 239.877 84.025 258.851 L 84.025 321.192 C 84.025 336.25 86.735 346.64 92.156 352.362 C 97.577 358.084 106.612 360.945 119.261 360.945 L 157.208 360.945 L 157.208 390.309 L 120.616 390.309 C 106.763 390.309 95.168 388.803 85.832 385.791 C 76.797 382.78 69.569 378.262 64.148 372.239 C 58.727 366.517 54.812 359.439 52.403 351.007 C 50.294 342.574 49.24 332.786 49.24 321.643 L 49.24 248.912 C 49.24 244.395 48.487 239.877 46.982 235.36 C 45.777 230.541 43.819 226.325 41.109 222.711 C 38.7 218.796 35.537 215.634 31.622 213.224 C 28.008 210.815 23.641 209.61 18.522 209.61 L 0 209.61 L 0 180.699 Z" fill="currentColor" />
      <path d="M 514.666 209.61 L 496.597 209.61 C 491.477 209.61 486.959 210.815 483.044 213.224 C 479.43 215.332 476.268 218.344 473.558 222.259 C 471.148 225.873 469.191 230.089 467.685 234.908 C 466.48 239.426 465.878 244.094 465.878 248.912 L 465.878 321.643 C 465.878 332.786 464.673 342.574 462.264 351.007 C 460.156 359.439 456.241 366.517 450.518 372.239 C 445.098 378.262 437.719 382.78 428.383 385.791 C 419.348 388.803 407.904 390.309 394.05 390.309 L 357.459 390.309 L 357.459 360.945 L 395.857 360.945 C 408.506 360.945 417.39 358.084 422.51 352.362 C 427.931 346.64 430.642 336.25 430.642 321.192 L 430.642 258.851 C 430.642 238.673 433.653 223.916 439.677 214.579 C 445.7 204.942 452.627 198.467 460.457 195.154 C 452.627 191.54 445.7 184.764 439.677 174.826 C 433.653 164.887 430.642 150.432 430.642 131.458 L 430.642 69.117 C 430.642 54.059 427.931 43.669 422.51 37.947 C 417.089 32.225 408.054 29.364 395.405 29.364 L 357.459 29.364 L 357.459 0 L 394.05 0 C 407.904 0 419.348 1.506 428.383 4.517 C 437.719 7.529 445.098 12.047 450.518 18.07 C 456.241 23.792 460.156 30.869 462.264 39.302 C 464.673 47.735 465.878 57.522 465.878 68.665 L 465.878 141.397 C 465.878 145.914 466.48 150.582 467.685 155.401 C 468.889 159.918 470.696 164.134 473.106 168.05 C 475.816 171.664 478.978 174.675 482.592 177.085 C 486.508 179.494 491.025 180.699 496.145 180.699 L 514.666 180.699 L 514.666 209.61 Z" fill="currentColor" />
    </svg>
  );
}

/* The {s} composed logo — braces with a mono s centered */
function BraceLogo({ size = 20, withS = true }) {
  return (
    <span className="brace-logo" style={{ fontSize: size + "px" }}>
      <span className="brace" style={{ height: size + "px" }}>
        <svg viewBox="0 0 130 390.309" fill="none" aria-hidden="true">
          <path d="M 0 180.699 L 18.07 180.699 C 23.19 180.699 27.707 179.644 31.622 177.536 C 35.537 175.127 38.7 172.115 41.109 168.501 C 43.819 164.586 45.777 160.37 46.982 155.852 C 48.487 151.034 49.24 146.215 49.24 141.397 L 49.24 68.665 C 49.24 57.522 50.294 47.735 52.403 39.302 C 54.812 30.869 58.727 23.792 64.148 18.07 C 69.569 12.047 76.797 7.529 85.832 4.517 C 95.168 1.506 106.763 0 120.616 0 L 157.208 0 L 157.208 29.364 L 118.809 29.364 C 106.16 29.364 97.125 32.225 91.704 37.947 C 86.585 43.669 84.025 54.059 84.025 69.117 L 84.025 131.458 C 84.025 151.636 81.013 166.544 74.99 176.181 C 68.967 185.517 62.04 191.842 54.21 195.154 C 62.04 198.768 68.967 205.545 74.99 215.483 C 81.013 225.421 84.025 239.877 84.025 258.851 L 84.025 321.192 C 84.025 336.25 86.735 346.64 92.156 352.362 C 97.577 358.084 106.612 360.945 119.261 360.945 L 157.208 360.945 L 157.208 390.309 L 120.616 390.309 C 106.763 390.309 95.168 388.803 85.832 385.791 C 76.797 382.78 69.569 378.262 64.148 372.239 C 58.727 366.517 54.812 359.439 52.403 351.007 C 50.294 342.574 49.24 332.786 49.24 321.643 L 49.24 248.912 C 49.24 244.395 48.487 239.877 46.982 235.36 C 45.777 230.541 43.819 226.325 41.109 222.711 C 38.7 218.796 35.537 215.634 31.622 213.224 C 28.008 210.815 23.641 209.61 18.522 209.61 L 0 209.61 L 0 180.699 Z" fill="currentColor" />
        </svg>
      </span>
      {withS && <span className="glyph">s</span>}
      <span className="brace" style={{ height: size + "px", transform: "scaleX(-1)" }}>
        <svg viewBox="0 0 130 390.309" fill="none" aria-hidden="true">
          <path d="M 0 180.699 L 18.07 180.699 C 23.19 180.699 27.707 179.644 31.622 177.536 C 35.537 175.127 38.7 172.115 41.109 168.501 C 43.819 164.586 45.777 160.37 46.982 155.852 C 48.487 151.034 49.24 146.215 49.24 141.397 L 49.24 68.665 C 49.24 57.522 50.294 47.735 52.403 39.302 C 54.812 30.869 58.727 23.792 64.148 18.07 C 69.569 12.047 76.797 7.529 85.832 4.517 C 95.168 1.506 106.763 0 120.616 0 L 157.208 0 L 157.208 29.364 L 118.809 29.364 C 106.16 29.364 97.125 32.225 91.704 37.947 C 86.585 43.669 84.025 54.059 84.025 69.117 L 84.025 131.458 C 84.025 151.636 81.013 166.544 74.99 176.181 C 68.967 185.517 62.04 191.842 54.21 195.154 C 62.04 198.768 68.967 205.545 74.99 215.483 C 81.013 225.421 84.025 239.877 84.025 258.851 L 84.025 321.192 C 84.025 336.25 86.735 346.64 92.156 352.362 C 97.577 358.084 106.612 360.945 119.261 360.945 L 157.208 360.945 L 157.208 390.309 L 120.616 390.309 C 106.763 390.309 95.168 388.803 85.832 385.791 C 76.797 382.78 69.569 378.262 64.148 372.239 C 58.727 366.517 54.812 359.439 52.403 351.007 C 50.294 342.574 49.24 332.786 49.24 321.643 L 49.24 248.912 C 49.24 244.395 48.487 239.877 46.982 235.36 C 45.777 230.541 43.819 226.325 41.109 222.711 C 38.7 218.796 35.537 215.634 31.622 213.224 C 28.008 210.815 23.641 209.61 18.522 209.61 L 0 209.61 L 0 180.699 Z" fill="currentColor" />
        </svg>
      </span>
    </span>
  );
}

/* SOMI token glyph */
function SomiIcon({ className, style }) {
  return (
    <svg className={className} style={style} viewBox="0 0 585.892 444.324" fill="none" aria-hidden="true">
      <path d="M 0 205.706 L 20.571 205.706 C 26.399 205.706 31.542 204.506 35.998 202.106 C 40.455 199.363 44.055 195.935 46.798 191.82 C 49.884 187.364 52.112 182.564 53.483 177.421 C 55.198 171.936 56.055 166.45 56.055 160.965 L 56.055 78.168 C 56.055 65.483 57.255 54.341 59.655 44.741 C 62.397 35.141 66.854 27.085 73.025 20.571 C 79.197 13.714 87.425 8.571 97.71 5.143 C 108.338 1.714 121.538 0 137.308 0 L 178.964 0 L 178.964 33.427 L 135.251 33.427 C 120.852 33.427 110.567 36.684 104.396 43.198 C 98.567 49.712 95.653 61.54 95.653 78.682 L 95.653 149.651 C 95.653 172.621 92.225 189.592 85.368 200.563 C 78.511 211.191 70.626 218.391 61.712 222.162 C 70.626 226.276 78.511 233.99 85.368 245.304 C 92.225 256.618 95.653 273.074 95.653 294.673 L 95.653 365.642 C 95.653 382.784 98.739 394.612 104.91 401.126 C 111.081 407.64 121.366 410.897 135.766 410.897 L 178.964 410.897 L 178.964 444.324 L 137.308 444.324 C 121.538 444.324 108.338 442.61 97.71 439.181 C 87.425 435.753 79.197 430.61 73.025 423.753 C 66.854 417.24 62.397 409.183 59.655 399.583 C 57.255 389.983 56.055 378.841 56.055 366.156 L 56.055 283.359 C 56.055 278.217 55.198 273.074 53.483 267.932 C 52.112 262.446 49.884 257.646 46.798 253.532 C 44.055 249.075 40.455 245.475 35.998 242.733 C 31.884 239.99 26.913 238.618 21.085 238.618 L 0 238.618 L 0 205.706 Z" fill="currentColor" />
      <path d="M 585.892 238.618 L 565.321 238.618 C 559.493 238.618 554.35 239.99 549.893 242.733 C 545.779 245.132 542.179 248.561 539.094 253.018 C 536.351 257.132 534.123 261.932 532.408 267.417 C 531.037 272.56 530.351 277.874 530.351 283.359 L 530.351 366.156 C 530.351 378.841 528.98 389.983 526.237 399.583 C 523.837 409.183 519.38 417.24 512.866 423.753 C 506.695 430.61 498.295 435.753 487.667 439.181 C 477.382 442.61 464.354 444.324 448.583 444.324 L 406.928 444.324 L 406.928 410.897 L 450.64 410.897 C 465.04 410.897 475.154 407.64 480.982 401.126 C 487.153 394.612 490.239 382.784 490.239 365.642 L 490.239 294.673 C 490.239 271.703 493.667 254.904 500.524 244.275 C 507.381 233.304 515.266 225.933 524.18 222.162 C 515.266 218.048 507.381 210.334 500.524 199.02 C 493.667 187.706 490.239 171.25 490.239 149.651 L 490.239 78.682 C 490.239 61.54 487.153 49.712 480.982 43.198 C 474.811 36.684 464.526 33.427 450.126 33.427 L 406.928 33.427 L 406.928 0 L 448.583 0 C 464.354 0 477.382 1.714 487.667 5.143 C 498.295 8.571 506.695 13.714 512.866 20.571 C 519.38 27.085 523.837 35.141 526.237 44.741 C 528.98 54.341 530.351 65.483 530.351 78.168 L 530.351 160.965 C 530.351 166.107 531.037 171.421 532.408 176.907 C 533.78 182.049 535.837 186.849 538.58 191.306 C 541.665 195.42 545.265 198.849 549.379 201.591 C 553.836 204.334 558.979 205.706 564.807 205.706 L 585.892 205.706 L 585.892 238.618 Z" fill="currentColor" />
    </svg>
  );
}

/* ------------------------------------------------------------------------
   On-chain avatars. PlayerProfile.avatar is a uint16 stored with the nickname;
   0 = "auto" (gradient + initial derived from the name hash), 1..N = curated
   looks below. IDs live on-chain — only APPEND to this list, never reorder.
   ------------------------------------------------------------------------ */
const SP_AVATARS = [
  null, // 0 = auto
  "🦊", "🐯", "🦁", "🐺", "🦅", "🐉", "🐍", "🦈", "🐼", "🦉", "🐳", "🐸",
  "👑", "🎩", "🃏", "💎", "⚡", "🔥", "🌙", "⭐", "🎲", "🏆", "🚀", "🤖",
];

/* One avatar look everywhere: seats, hero, cashier, standings.
   Precedence: `img` (player-uploaded, stored on-chain in AvatarStore, passed
   as a data URI) → `av` preset id → auto gradient/initial from the name.
   Pass `size` for inline (small) usages; without it the .avatar CSS sizes it. */
function AvatarIcon({ av, img, name, size, style }) {
  const box = size ? { width: size, height: size, fontSize: Math.round(size * 0.38) } : undefined;
  if (img) {
    return (
      <div className="avatar deco" style={{ background: `url("${img}") center/cover no-repeat, #15151c`, ...box, ...style }}>
        <span className="ava-grid" />
      </div>
    );
  }
  const id = Number(av) || 0;
  const glyph = id > 0 ? SP_AVATARS[id] : null;
  // preset avatars keep a stable gradient per id; auto derives from the name
  const c = avatarColors(glyph ? "av" + id : (name || "?"));
  return (
    <div className="avatar deco" style={{ background: `linear-gradient(${c.rot}deg, ${c.a}, ${c.b})`, ...box, ...style }}>
      <SparkMark style={{ position: "absolute", inset: "10%", color: "rgba(255,246,221,.30)", transform: `rotate(${(c.rot % 50) - 25}deg)` }} />
      {glyph
        ? <span className="em" style={{ position: "relative", ...(size ? { fontSize: Math.round(size * 0.54) } : {}) }}>{glyph}</span>
        : <span style={{ position: "relative" }}>{(name || "?").replace(/^0x/i, "")[0].toUpperCase()}</span>}
      <span className="ava-grid" />
    </div>
  );
}

/* Client-side crop+compress for avatar upload: center-crop to a square,
   resize to 96×96, walk WebP quality down until it fits the on-chain cap.
   Returns { bytes: Uint8Array, dataUri } or throws. */
function SPCompressAvatar(file, maxBytes = 7800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(im.width, im.height);
      const cv = document.createElement("canvas");
      cv.width = cv.height = 96;
      const ctx = cv.getContext("2d");
      ctx.drawImage(im, (im.width - side) / 2, (im.height - side) / 2, side, side, 0, 0, 96, 96);
      for (let q = 0.85; q >= 0.3; q -= 0.1) {
        const uri = cv.toDataURL("image/webp", q);
        const b64 = uri.split(",")[1];
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        if (bytes.length <= maxBytes) return resolve({ bytes, dataUri: uri });
      }
      reject(new Error("image won't compress under the on-chain cap — try a simpler picture"));
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not read that image")); };
    im.src = url;
  });
}

Object.assign(window, { Card, Suit, BraceMark, BraceLogo, SomiIcon, SparkLogo, SparkMark, avatarColors, SP_AVATARS, AvatarIcon, SPCompressAvatar });

/* ------------------------------------------------------------------------
   i18n (EN/RU) for the live-table experience. First-loaded script → every
   later classic script can call window.SPT / window.SPTHand. The language
   toggle lives in the table settings panel; persisted in localStorage.
   ------------------------------------------------------------------------ */
const SP_I18N_RU = {
  "YOU": "ВЫ", "Total pot": "Банк", "chips": "фишек", "Waiting for players": "Ожидание игроков",
  "all-in": "олл-ин", "folded": "фолд", "sitting out": "сит-аут", "waiting": "ожидание",
  "Fold": "Фолд", "Check": "Чек", "Call": "Колл", "Raise to": "Рейз до", "Bet": "Бет",
  "Min": "Мин", "Pot": "Банк", "All-in": "Олл-ин", "Best": "Комбо", "Pot odds": "Шансы банка",
  "You win": "Вы выиграли", "You lose": "Вы проиграли", "wins": "выигрывает",
  "paid out on-chain": "— выплата он-чейн", "pot settled on-chain": "банк рассчитан он-чейн",
  "Winning hand": "Победная рука", "Settling pot on-chain…": "Банк рассчитывается он-чейн…",
  "Action sent": "Действие отправлено", "Confirming on-chain…": "Подтверждаем он-чейн…",
  "Dealer button": "Баттон (дилер) — раздача идёт от него", "Small blind": "Малый блайнд", "Big blind": "Большой блайнд",
  "Sign in to play": "Войдите, чтобы играть",
  "Email login → instant Somnia wallet, no popups": "Вход по email → мгновенный кошелёк Somnia, без попапов",
  "Take an empty seat to join": "Сядьте на свободное место",
  "Click a “+ Sit” spot around the table": "Нажмите «+ Sit» на свободном месте за столом",
  "Tournament table — you're observing": "Турнирный стол — вы наблюдаете",
  "Seats are assigned by the tournament; register on its page to play": "Места раздаёт турнир — зарегистрируйтесь на его странице, чтобы играть",
  "Showdown — settling on-chain": "Шоудаун — расчёт он-чейн",
  "Waiting for your turn": "Ожидание вашего хода",
  "Waiting for the next hand": "Ожидание следующей руки",
  "Your chips & action are safe on-chain": "Ваши фишки и действия защищены он-чейн",
  "Pre-action armed — fires instantly on your turn": "Пре-действие взведено — сработает в ваш ход",
  "TOURNAMENT": "ТУРНИР", "Level": "Уровень", "Blinds": "Блайнды", "ante": "анте",
  "Next level": "След. уровень", "Final level": "Финальный уровень", "Players": "Игроки",
  "Prize": "Приз", "Split": "Сплит", "FINISHED": "ЗАВЕРШЁН",
  "Table": "Стол", "Switch to this table": "Перейти к этому столу",
  "Hand": "Рука", "Cashier": "Касса", "Connect Wallet": "Подключить кошелёк",
  "Say something…": "Напишите что-нибудь…", "Sit down to chat": "Сядьте за стол, чтобы писать", "Send": "Отпр.",
  "table chat · dealer feed": "чат стола · лента дилера", "hand history · on-chain": "история рук · он-чейн", "private player notes": "приватные заметки",
  "chat": "чат", "hands": "руки", "notes": "заметки",
  "provably fair · commit-reveal": "честная раздача · commit-reveal",
  "shuffling — commitment sealed on-chain": "тасуем — коммит колоды запечатан он-чейн",
  "table settings": "настройки стола", "Table theme": "Тема стола", "Sound effects": "Звуки",
  "4-color deck": "4-цветная колода", "Turbo animations": "Турбо-анимации", "Reduced motion": "Меньше анимаций",
  "Stacks in big blinds": "Стеки в блайндах (BB)",
  "Language": "Язык", "Close": "Закрыть",
  "Sit at seat": "Сесть на место", "Buy-in": "Бай-ин", "Cancel": "Отмена", "Take seat": "Сесть",
  "Leave table": "Покинуть стол", "Back to tournament": "К турниру", "Settings": "Настройки",
  "Sit out": "Сит-аут", "Sit in": "Вернуться в игру", "Sit": "Сесть", "Connect": "Войти",
};
window.__SPLANG = (function () { try { return localStorage.getItem("sp_lang") || "en"; } catch (e) { return "en"; } })();
window.SPT = (s) => (window.__SPLANG === "en" ? s : (SP_I18N_RU[s] != null ? SP_I18N_RU[s] : s));
window.SPLangSet = (l) => { window.__SPLANG = l; try { localStorage.setItem("sp_lang", l); } catch (e) {} };

/* Hand-name translator: maps the evaluator's English combos ("Pair of Nines",
   "Flush, King high"…) to Russian poker terms. EN → passthrough. */
const SP_EN_RANKS = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Jack", "Queen", "King", "Ace"];
const SP_EN_PLURAL = ["Twos", "Threes", "Fours", "Fives", "Sixes", "Sevens", "Eights", "Nines", "Tens", "Jacks", "Queens", "Kings", "Aces"];
const SP_RU_HIGH = ["двойки", "тройки", "четвёрки", "пятёрки", "шестёрки", "семёрки", "восьмёрки", "девятки", "десятки", "вальта", "дамы", "короля", "туза"];
const SP_RU_PL = ["двоек", "троек", "четвёрок", "пятёрок", "шестёрок", "семёрок", "восьмёрок", "девяток", "десяток", "вальтов", "дам", "королей", "тузов"];
const spRuHigh = (w) => SP_RU_HIGH[SP_EN_RANKS.indexOf(w)] || w;
const spRuPl = (w) => SP_RU_PL[SP_EN_PLURAL.indexOf(w)] || w;
window.SPTHand = (name) => {
  if (!name || window.__SPLANG === "en") return name;
  let m;
  if (name === "Royal Flush") return "Флеш-рояль";
  if ((m = name.match(/^Straight Flush, (\w+) high$/))) return "Стрит-флеш до " + spRuHigh(m[1]);
  if ((m = name.match(/^Four of a Kind, (\w+)$/))) return "Каре из " + spRuPl(m[1]);
  if ((m = name.match(/^Full House, (\w+) full of (\w+)$/))) return "Фулл-хаус: " + spRuPl(m[1]) + " и " + spRuPl(m[2]);
  if ((m = name.match(/^Flush, (\w+) high$/))) return "Флеш до " + spRuHigh(m[1]);
  if ((m = name.match(/^Straight, (\w+) high$/))) return "Стрит до " + spRuHigh(m[1]);
  if ((m = name.match(/^Three of a Kind, (\w+)$/))) return "Сет из " + spRuPl(m[1]);
  if ((m = name.match(/^Two Pair, (\w+) & (\w+)$/))) return "Две пары: " + spRuPl(m[1]) + " и " + spRuPl(m[2]);
  if ((m = name.match(/^Pair of (\w+)$/))) return "Пара " + spRuPl(m[1]);
  if ((m = name.match(/^(\w+) high$/))) return "Старшая карта — " + spRuHigh(m[1]);
  return name;
};
