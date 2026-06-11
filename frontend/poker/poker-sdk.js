// ShinyPoker SDK — the single integration layer between the UI and the on-chain
// PokerRoom + CommitRevealDealer, plus the off-chain dealer's hole-card API.
// ES module; ethers comes from the same vendored bundle ShinyLuck uses.
import { ethers } from "/vendor/ethers.bundle.js";
import { POKER_CONFIG, NETWORK } from "./poker-config.js";

export const ACTION = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALLIN: 5 };
export const STREET = { PREFLOP: 0, FLOP: 1, TURN: 2, RIVER: 3, SHOWDOWN: 4, IDLE: 255 };
export const STREET_NAME = ["Preflop", "Flop", "Turn", "River", "Showdown"];

const ROOM_ABI = [
  "function tableCount() view returns (uint256)",
  "function getTable(uint256) view returns (tuple(uint8 maxSeats,uint128 smallBlind,uint128 bigBlind,uint128 ante,uint128 minBuyIn,uint128 maxBuyIn,uint16 rakeBps,uint128 rakeCap,uint32 actionTimeout,bool active))",
  "function getSeat(uint256,uint8) view returns (tuple(address player,uint128 stack,bool occupied,bool sittingOut,uint64 sitInHandId))",
  "function getHand(uint256) view returns (tuple(uint64 handId,uint8 street,uint8 button,uint8 actingSeat,uint8 aggressorSeat,uint8 numInHand,uint128 currentBet,uint128 minRaise,uint128 pot,uint64 actingDeadline,uint256 dealId,bool inProgress))",
  "function getSeatHand(uint256,uint8) view returns (tuple(bool inHand,bool folded,bool allIn,bool hasActed,uint128 committedStreet,uint128 committedTotal))",
  "function seatOf(uint256,address) view returns (uint8)",
  "function balance(address) view returns (uint256)",
  "function handCounter(uint256) view returns (uint64)",
  "function deposit() payable",
  "function withdraw(uint256)",
  "function sitDown(uint256,uint8,uint128)",
  "function topUp(uint256,uint128)",
  "function leaveTable(uint256)",
  "function setSitOut(uint256,bool)",
  "function act(uint256,uint8,uint128)",
  "function timeoutAct(uint256)",
  "function setSessionKey(address) payable",
  "function revokeSessionKey()",
  "function sessionKeyOf(address) view returns (address)",
  "function sessionOwnerOf(address) view returns (address)",
  "function tableController(uint256) view returns (address)",
];

const TRN_ABI = [
  "function count() view returns (uint256)",
  "function info(uint256) view returns (address creator,uint128 buyIn,uint128 fee,uint128 startStack,uint128 pool,uint8 maxPlayers,uint8 registered,uint8 status,uint8 remaining,uint256 tableId,uint16[] payoutBps)",
  "function clock(uint256) view returns (uint64 startedAt,uint8 level,uint64 levelDur,uint128 sbStart,uint128 bbStart)",
  "function isRegistered(uint256,address) view returns (bool)",
  "function createTournament(uint128 buyIn,uint128 fee,uint8 maxPlayers,uint128 startStack,uint128 sbStart,uint128 bbStart,uint64 levelDur,uint16[] payoutBps) payable returns (uint256)",
  "function register(uint256) payable",
  "function unregister(uint256)",
  "function start(uint256)",
];

export const TRN_STATUS = ["Registering", "Running", "Finished", "Cancelled"];

const DEALER_ABI = [
  "function boardCards(uint256) view returns (uint8[5])",
  "function holeCards(uint256,uint8) view returns (uint8,uint8)",
  "function boardRevealedCount(uint256) view returns (uint8)",
  "function isShowdownReady(uint256) view returns (bool)",
  "function dealInfo(uint256) view returns (uint64 handId,uint64 tableId,uint64 commitBlock,uint8 playerCount,bytes32 seedHash,bytes32 entropy,bytes32 serverSeed,bool revealed,uint8[] seats)",
];

const ROOM_EVENTS = [
  "event HandSettled(uint256 indexed tableId, uint64 indexed handId, uint8 winnerSeat, uint128 amountWon, uint128 rake)",
  "event PotWinner(uint256 indexed tableId, uint64 indexed handId, uint8 potIndex, uint8 seat, uint128 amount)",
];
ROOM_ABI.push(...ROOM_EVENTS);

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["♣", "♦", "♥", "♠"];
export const cardRank = (c) => Math.floor(c / 4);
export const cardSuit = (c) => c % 4;
export const cardLabel = (c) => (c === 255 || c == null ? null : { rank: RANKS[cardRank(c)], suit: SUITS[cardSuit(c)], red: cardSuit(c) === 1 || cardSuit(c) === 2 });

export class ShinyPoker {
  constructor(cfg = POKER_CONFIG, net = NETWORK) {
    this.cfg = cfg;
    this.net = net;
    this.read = new ethers.JsonRpcProvider(net.rpcUrls[0]);
    // Guard against pre-deploy empty addresses (would throw in ethers.Contract).
    this.roomRead = cfg.pokerRoom ? new ethers.Contract(cfg.pokerRoom, ROOM_ABI, this.read) : null;
    this.dealerRead = cfg.commitRevealDealer ? new ethers.Contract(cfg.commitRevealDealer, DEALER_ABI, this.read) : null;
    this.trnRead = cfg.pokerTournament ? new ethers.Contract(cfg.pokerTournament, TRN_ABI, this.read) : null;
    this.trnWrite = null;
    this.signer = null;
    this.address = null;
    this.roomWrite = null;
    this.sessionWallet = null; // in-browser hot key
    this.roomSession = null; // room contract bound to the session wallet
    this.sessionActive = false;
    this.backend = null; // "privy" | "injected"
    try { this.read.pollingInterval = 800; } catch {}
    this._tableCfg = new Map();
  }

  // ---- wallet ----
  /// Open the connect chooser (email/Privy primary; injected wallets in beta),
  /// or pass a method to skip it.
  async connect(method) {
    if (this.address) return this.address;
    if (!method) method = await this._chooseWallet();
    return method === "privy" ? this.connectPrivy() : this.connectInjected();
  }

  /// Email login → embedded Somnia wallet (HEADLESS — no popup for txs or
  /// signatures), shared with the ShinyLuck casino via the reused Privy bundle.
  async connectPrivy() {
    const auth = window.ShinyLuckAuth;
    if (!auth) throw new Error("Email login unavailable (Privy bundle not loaded).");
    if (!auth.ready) await this._privyWait((d) => d.ready);
    if (!window.ShinyLuckAuth.authenticated) await window.ShinyLuckAuth.login();
    if (!window.ShinyLuckAuth.authenticated || !window.ShinyLuckAuth.address) await this._privyWait((d) => d.authenticated && d.address, 120000);
    await this._attachPrivy(window.ShinyLuckAuth.address);
    return this.address;
  }

  /// Silently re-attach an existing Privy session on page load.
  async tryRestorePrivy() {
    const a = window.ShinyLuckAuth;
    if (!this.address && a && a.ready && a.authenticated && a.address) { await this._attachPrivy(a.address); return this.address; }
    return null;
  }

  _bindWrites() {
    this.roomWrite = new ethers.Contract(this.cfg.pokerRoom, ROOM_ABI, this.signer);
    this.trnWrite = this.cfg.pokerTournament ? new ethers.Contract(this.cfg.pokerTournament, TRN_ABI, this.signer) : null;
  }

  async _attachPrivy(address) {
    const { PrivySigner } = await import("/lib/privy-signer.js");
    this.signer = new PrivySigner(address, this.read);
    this.address = address;
    this._bindWrites();
    this.backend = "privy";
    if (typeof this.signer.prewarm === "function") this.signer.prewarm();
  }

  _privyWait(pred, ms = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { document.removeEventListener("shinyluck:auth-state", on); reject(new Error("Privy timeout")); }, ms);
      const on = (ev) => { if (pred(ev.detail || {})) { clearTimeout(t); document.removeEventListener("shinyluck:auth-state", on); resolve(); } };
      document.addEventListener("shinyluck:auth-state", on);
      const a = window.ShinyLuckAuth;
      if (a && pred({ ready: a.ready, authenticated: a.authenticated, address: a.address })) { clearTimeout(t); document.removeEventListener("shinyluck:auth-state", on); resolve(); }
    });
  }

  /// Injected wallet (MetaMask etc.) — BETA. Popup-free play via a session key.
  async connectInjected() {
    if (!window.ethereum) throw new Error("No injected wallet found. Use email login.");
    try { await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] }); }
    catch (e) { if (e && e.code === 4001) throw e; }
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await this.ensureChain();
    this.provider = new ethers.BrowserProvider(window.ethereum);
    this.signer = await this.provider.getSigner();
    this.address = await this.signer.getAddress();
    this._bindWrites();
    this.backend = "injected";
    await this.loadSession();
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
    return this.address;
  }

  /// True when actions need no per-action popup (Privy is always; injected once a session is granted).
  popupFree() { return this.backend === "privy" || this.sessionActive; }

  // wallet chooser modal (email primary, injected wallets flagged BETA)
  _chooseWallet() {
    const ACC = "#6e6eed", ACC2 = "#9b9bf4";
    return new Promise((resolve, reject) => {
      const mask = document.createElement("div");
      mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(8px);z-index:9000;display:grid;place-items:center;padding:24px;font-family:'Source Code Pro',monospace";
      const hasInjected = !!window.ethereum;
      mask.innerHTML = `
        <div style="background:#111114;border:1px solid #2c2c36;border-radius:16px;max-width:400px;width:100%;padding:26px;color:#e6e6ee">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <h3 style="margin:0;font-family:'IBM Plex Mono',monospace;font-size:18px">Connect to <span style="color:${ACC}">ShinyPoker</span></h3>
            <button data-x style="background:transparent;border:1px solid #2c2c36;color:#9a9aa8;border-radius:8px;padding:4px 9px;cursor:pointer">✕</button>
          </div>
          <p style="margin:0 0 18px;font-size:12px;color:#9a9aa8;line-height:1.55">Sign in with email to get a Somnia wallet — same wallet as the ShinyLuck casino, no extension, and <b style="color:${ACC2}">no popups</b> while you play.</p>
          <button data-m="privy" style="display:flex;align-items:center;gap:10px;width:100%;padding:13px 14px;margin-bottom:9px;background:${ACC};border:1px solid ${ACC};color:#fff;border-radius:10px;cursor:pointer;font-family:inherit;font-size:14px;font-weight:600">📧 Continue with Email</button>
          <button data-m="injected" ${hasInjected ? "" : "disabled"} style="display:flex;align-items:center;justify-content:space-between;width:100%;padding:13px 14px;margin-bottom:9px;background:#1c1c22;border:1px solid #2c2c36;color:${hasInjected ? "#e6e6ee" : "#5a5a66"};border-radius:10px;cursor:${hasInjected ? "pointer" : "not-allowed"};font-family:inherit;font-size:14px">
            <span>🦊 MetaMask${hasInjected ? "" : " (not detected)"}</span><span style="font-size:9px;letter-spacing:1px;background:rgba(232,193,90,.15);color:#e8c15a;border:1px solid rgba(232,193,90,.3);border-radius:999px;padding:2px 7px">BETA</span>
          </button>
          <button disabled style="display:flex;align-items:center;justify-content:space-between;width:100%;padding:13px 14px;background:#1c1c22;border:1px solid #2c2c36;color:#5a5a66;border-radius:10px;cursor:not-allowed;font-family:inherit;font-size:14px">
            <span>🔗 WalletConnect</span><span style="font-size:9px;letter-spacing:1px;background:rgba(232,193,90,.12);color:#e8c15a;border:1px solid rgba(232,193,90,.25);border-radius:999px;padding:2px 7px">SOON</span>
          </button>
          <div style="font-size:10px;color:#6a6a78;margin-top:16px;letter-spacing:.06em;text-transform:uppercase">Powered by Privy · Somnia · ${this.net.currency.symbol}</div>
        </div>`;
      document.body.appendChild(mask);
      const done = (v, err) => { mask.remove(); err ? reject(err) : resolve(v); };
      mask.addEventListener("click", (e) => {
        if (e.target === mask || e.target.hasAttribute("data-x")) return done(null, new Error("cancelled"));
        const b = e.target.closest("[data-m]");
        if (b && !b.disabled) done(b.getAttribute("data-m"));
      });
    });
  }

  // ---- session keys (act without a wallet popup per action) ----
  _sessKey() { return ("sp_sess_" + this.net.chainId + "_" + this.cfg.pokerRoom + "_" + this.address).toLowerCase(); }

  _bindSession(priv) {
    this.sessionWallet = new ethers.Wallet(priv, this.read);
    this.roomSession = new ethers.Contract(this.cfg.pokerRoom, ROOM_ABI, this.sessionWallet);
  }

  /// Restore a saved session and confirm it's still authorized on-chain.
  async loadSession() {
    this.sessionActive = false;
    const priv = (typeof localStorage !== "undefined") ? localStorage.getItem(this._sessKey()) : null;
    if (!priv) return false;
    try {
      this._bindSession(priv);
      const onchain = await this.roomRead.sessionKeyOf(this.address);
      if (onchain.toLowerCase() === this.sessionWallet.address.toLowerCase()) { this.sessionActive = true; return true; }
    } catch {}
    return false;
  }

  /// Generate a hot key, authorize + fund it on-chain (one wallet popup), and
  /// route all subsequent actions through it — no popup per action.
  async activateSession(gasEth = 0.05) {
    this.requireWallet();
    const key = ethers.Wallet.createRandom();
    localStorage.setItem(this._sessKey(), key.privateKey);
    await (await this.roomWrite.setSessionKey(key.address, { value: ethers.parseEther(String(gasEth)) })).wait();
    this._bindSession(key.privateKey);
    this.sessionActive = true;
    return key.address;
  }

  async revokeSession() {
    this.requireWallet();
    try { await (await this.roomWrite.revokeSessionKey()).wait(); } catch {}
    if (typeof localStorage !== "undefined") localStorage.removeItem(this._sessKey());
    this.sessionWallet = null; this.roomSession = null; this.sessionActive = false;
  }

  async signOut() {
    try { if (this.backend === "privy" && window.ShinyLuckAuth && window.ShinyLuckAuth.logout) await window.ShinyLuckAuth.logout(); } catch {}
    if (this.sessionActive) { try { await this.revokeSession(); } catch {} }
    this.address = null; this.signer = null; this.roomWrite = null; this.backend = null;
  }

  hasSession() { return this.sessionActive; }
  sessionAddress() { return this.sessionWallet ? this.sessionWallet.address : null; }
  async sessionGas() { return this.sessionWallet ? this.read.getBalance(this.sessionWallet.address) : 0n; }

  async ensureChain() {
    const cur = await window.ethereum.request({ method: "eth_chainId" });
    if (cur.toLowerCase() === this.net.chainIdHex.toLowerCase()) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: this.net.chainIdHex }] });
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: this.net.chainIdHex, chainName: this.net.name, rpcUrls: this.net.rpcUrls,
            nativeCurrency: this.net.currency, blockExplorerUrls: [this.net.explorer],
          }],
        });
      } else throw e;
    }
  }

  requireWallet() {
    if (!this.roomWrite) throw new Error("Connect your wallet first.");
  }

  // ---- reads ----
  async tableCount() { return Number(await this.roomRead.tableCount()); }

  async getTable(t) {
    if (this._tableCfg.has(t)) return this._tableCfg.get(t);
    const c = await this.roomRead.getTable(t);
    const cfg = {
      maxSeats: Number(c.maxSeats), smallBlind: c.smallBlind, bigBlind: c.bigBlind, ante: c.ante,
      minBuyIn: c.minBuyIn, maxBuyIn: c.maxBuyIn, rakeBps: Number(c.rakeBps), rakeCap: c.rakeCap,
      actionTimeout: Number(c.actionTimeout), active: c.active,
    };
    this._tableCfg.set(t, cfg);
    return cfg;
  }

  async getHand(t) {
    const h = await this.roomRead.getHand(t);
    return {
      handId: Number(h.handId), street: Number(h.street), button: Number(h.button),
      actingSeat: Number(h.actingSeat), numInHand: Number(h.numInHand), currentBet: h.currentBet,
      minRaise: h.minRaise, pot: h.pot, actingDeadline: Number(h.actingDeadline),
      dealId: h.dealId, inProgress: h.inProgress,
    };
  }

  async getSeats(t) {
    const cfg = await this.getTable(t);
    // Read all seats concurrently — sequential awaits made the first paint slow.
    const idx = Array.from({ length: cfg.maxSeats }, (_, i) => i);
    return Promise.all(idx.map(async (s) => {
      const [seat, sh] = await Promise.all([this.roomRead.getSeat(t, s), this.roomRead.getSeatHand(t, s)]);
      return {
        index: s, player: seat.player, occupied: seat.occupied, sittingOut: seat.sittingOut,
        stack: seat.stack, empty: seat.player === ethers.ZeroAddress,
        inHand: sh.inHand, folded: sh.folded, allIn: sh.allIn, committedStreet: sh.committedStreet,
      };
    }));
  }

  async board(dealId) {
    if (!dealId || dealId === 0n || !this.dealerRead) return [];
    // Only the first `boardRevealedCount` slots are real; the rest default to 0
    // on-chain (which is the "2♣" card) — never show those.
    const n = Number(await this.dealerRead.boardRevealedCount(dealId));
    if (n === 0) return [];
    const raw = await this.dealerRead.boardCards(dealId);
    return raw.map(Number).slice(0, n);
  }

  async balanceOf(addr) { return this.roomRead.balance(addr); }

  /// Native STT/SOMI balance of the connected wallet (for funding guidance).
  async walletBalance() { return this.address ? this.read.getBalance(this.address) : 0n; }

  // ---- tournaments ----
  hasTournaments() { return !!this.trnRead; }

  async tournamentCount() { return this.trnRead ? Number(await this.trnRead.count()) : 0; }

  async tournamentInfo(id) {
    const i = await this.trnRead.info(id);
    return {
      id, creator: i.creator, buyIn: i.buyIn, fee: i.fee, startStack: i.startStack, pool: i.pool,
      maxPlayers: Number(i.maxPlayers), registered: Number(i.registered), status: Number(i.status),
      remaining: Number(i.remaining), tableId: Number(i.tableId), payoutBps: i.payoutBps.map(Number),
    };
  }

  async tournaments() {
    const n = await this.tournamentCount();
    const ids = Array.from({ length: n }, (_, i) => i);
    return Promise.all(ids.map((i) => this.tournamentInfo(i)));
  }

  async tournamentClock(id) {
    const c = await this.trnRead.clock(id);
    return { startedAt: Number(c.startedAt), level: Number(c.level), levelDur: Number(c.levelDur), sbStart: c.sbStart, bbStart: c.bbStart };
  }

  async isRegisteredIn(id) { return this.address ? this.trnRead.isRegistered(id, this.address) : false; }

  /// Find the tournament that controls `tableId` (or null for a cash table).
  async tournamentOfTable(tableId) {
    if (!this.trnRead || !this.roomRead) return null;
    const ctl = await this.roomRead.tableController(tableId);
    if (ctl === ethers.ZeroAddress || ctl.toLowerCase() !== this.cfg.pokerTournament.toLowerCase()) return null;
    const all = await this.tournaments();
    return all.find((t) => t.status === 1 && t.tableId === tableId) || all.find((t) => t.tableId === tableId) || null;
  }

  /// Create a tournament. buyIn/fee/sponsor in ether units; chips/blinds are
  /// plain tournament-chip integers; payoutBps must sum to 10000.
  async createTournament({ buyInEth = 0, feeEth = 0, maxPlayers, startStack, sbStart, bbStart, levelDur, payoutBps, sponsorEth = 0 }) {
    this.requireWallet();
    if (!this.trnWrite) throw new Error("tournaments not deployed");
    return (await this.trnWrite.createTournament(
      ethers.parseEther(String(buyInEth)), ethers.parseEther(String(feeEth)), maxPlayers,
      BigInt(startStack), BigInt(sbStart), BigInt(bbStart), BigInt(levelDur), payoutBps,
      { value: ethers.parseEther(String(sponsorEth)) },
    )).wait();
  }

  async registerTournament(id, costWei) {
    this.requireWallet();
    return (await this.trnWrite.register(id, { value: costWei })).wait();
  }

  async unregisterTournament(id) { this.requireWallet(); return (await this.trnWrite.unregister(id)).wait(); }
  async startTournament(id) { this.requireWallet(); return (await this.trnWrite.start(id)).wait(); }

  /// Recent settled hands at a table — served by the dealer bot's indexer
  /// (it backfills the on-chain events once and stays current; scanning
  /// Somnia's ~0.2s-block history from the browser is impractical).
  async recentHands(t) {
    try {
      const res = await fetch(`${this.cfg.dealerApiUrl}/history?t=${t}`);
      if (res.ok) {
        const { hands } = await res.json();
        return (hands || []).map((h) => ({ ...h, amount: BigInt(h.amount) }));
      }
    } catch {}
    return this._recentHandsOnchain(t); // bot down → short on-chain fallback
  }

  // (fallback) raw eth_getLogs over a short recent window — Somnia logs lack
  // the `removed` field which trips ethers v6's validator, hence raw calls.
  async _recentHandsOnchain(t, lookback = 18000) {
    if (!this.roomRead) return [];
    const iface = this.roomRead.interface;
    const addr = this.cfg.pokerRoom;
    const tTopic = ethers.zeroPadValue(ethers.toBeHex(t), 32);
    const latest = await this.read.getBlockNumber();
    const from0 = Math.max(0, latest - lookback);
    const out = [];
    const grab = async (evName, fromB, toB) => {
      const topic = iface.getEvent(evName).topicHash;
      const logs = await this.read.send("eth_getLogs", [{
        address: addr, topics: [topic, tTopic],
        fromBlock: "0x" + fromB.toString(16), toBlock: "0x" + toB.toString(16),
      }]);
      for (const lg of logs) {
        try {
          const p = iface.parseLog({ topics: lg.topics, data: lg.data });
          if (evName === "HandSettled") out.push({ handId: Number(p.args.handId), seat: Number(p.args.winnerSeat), amount: p.args.amountWon, kind: "fold-win" });
          else out.push({ handId: Number(p.args.handId), seat: Number(p.args.seat), amount: p.args.amount, kind: "showdown" });
        } catch {}
      }
    };
    // Parallel batched chunks (RPC caps eth_getLogs at ~1000-block ranges).
    const chunks = [];
    for (let from = from0; from <= latest; from += 900) chunks.push([from, Math.min(from + 899, latest)]);
    for (let i = 0; i < chunks.length; i += 6) {
      await Promise.all(chunks.slice(i, i + 6).flatMap(([f, t2]) =>
        [grab("HandSettled", f, t2).catch(() => {}), grab("PotWinner", f, t2).catch(() => {})]));
    }
    out.sort((a, b) => b.handId - a.handId);
    return out.slice(0, 40);
  }

  /// Current deal's provably-fair metadata (seed commitment, reveal state).
  async dealCommit(dealId) {
    if (!this.dealerRead || !dealId || dealId === 0n) return null;
    const d = await this.dealerRead.dealInfo(dealId);
    return { seedHash: d.seedHash, revealed: d.revealed, serverSeed: d.serverSeed, commitBlock: Number(d.commitBlock) };
  }

  // ---- table chat (relayed by the dealer bot; signed, popup-free w/ session) ----
  chatMessage(t, text) { return `ShinyPoker:chat:${t}:${text}`; }

  async sendChat(t, text) {
    this.requireWallet();
    const msg = this.chatMessage(t, text);
    const signature = this.sessionActive && this.sessionWallet
      ? await this.sessionWallet.signMessage(msg)
      : await this.signer.signMessage(msg);
    const res = await fetch(`${this.cfg.dealerApiUrl}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tableId: t, text, signature }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "chat unavailable");
  }

  async getChat(t, since = 0) {
    const res = await fetch(`${this.cfg.dealerApiUrl}/chat?t=${t}&since=${since}`);
    if (!res.ok) return [];
    return (await res.json()).messages || [];
  }

  /// A seat's hole cards once the deck is revealed at showdown (public).
  async revealedHole(dealId, seat) {
    const [a, b] = await this.dealerRead.holeCards(dealId, seat);
    return [Number(a), Number(b)];
  }

  /// One combined snapshot for the UI.
  async snapshot(t) {
    const [cfg, hand, seats] = await Promise.all([this.getTable(t), this.getHand(t), this.getSeats(t)]);
    const board = hand.inProgress ? await this.board(hand.dealId) : [];
    const mySeat = this.address ? seats.findIndex((s) => s.player.toLowerCase() === this.address.toLowerCase()) : -1;
    return { tableId: t, cfg, hand, seats, board, mySeat };
  }

  holeMessage(t, dealId) { return `ShinyPoker:holes:${t}:${Number(dealId)}`; }

  /// Sign the hole-card request. When a session is active the in-browser session
  /// key signs it silently (NO wallet popup) — the dealer accepts a session-key
  /// signature on the seat owner's behalf.
  async signHoles(t, dealId) {
    const msg = this.holeMessage(t, dealId);
    if (this.sessionActive && this.sessionWallet) return this.sessionWallet.signMessage(msg);
    this.requireWallet();
    return this.signer.signMessage(msg);
  }

  /// Ask the off-chain dealer for THIS player's two hole cards (signature-gated).
  async myHoleCards(t, dealId, signature) {
    if (!signature) signature = await this.signHoles(t, dealId);
    const res = await fetch(`${this.cfg.dealerApiUrl}/holes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tableId: t, dealId: Number(dealId), signature }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "cards unavailable");
    return res.json(); // { seat, cards:[c0,c1], cardsStr:[..] }
  }

  // ---- writes ----
  async deposit(amountEth) { this.requireWallet(); return (await this.roomWrite.deposit({ value: ethers.parseEther(String(amountEth)) })).wait(); }
  async withdraw(amountEth) { this.requireWallet(); return (await this.roomWrite.withdraw(ethers.parseEther(String(amountEth)))).wait(); }
  async sitDown(t, seat, buyInEth) { this.requireWallet(); return (await this.roomWrite.sitDown(t, seat, ethers.parseEther(String(buyInEth)))).wait(); }
  async topUp(t, amountEth) { this.requireWallet(); return (await this.roomWrite.topUp(t, ethers.parseEther(String(amountEth)))).wait(); }
  async leave(t) { this.requireWallet(); return (await this.roomWrite.leaveTable(t)).wait(); }
  async sitOut(t, on) { this.requireWallet(); return (await this.roomWrite.setSitOut(t, on)).wait(); }

  /// `amount` is the raise-to total for BET/RAISE; ignored otherwise. Cash
  /// tables take ether units; tournament tables play in plain CHIP integers —
  /// pass chips=true there (parseEther would send 1e18× too much and revert).
  async act(t, action, amount = 0, chips = false) {
    this.requireWallet();
    const amt = action === ACTION.BET || action === ACTION.RAISE
      ? (chips ? BigInt(Math.round(Number(amount))) : ethers.parseEther(String(amount)))
      : 0;
    // Route through the session key when active → no wallet popup per action.
    const room = this.sessionActive && this.roomSession ? this.roomSession : this.roomWrite;
    return (await room.act(t, action, amt)).wait();
  }

  // ---- live polling ----
  watch(t, cb, intervalMs = 1200) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try { cb(await this.snapshot(t)); } catch (e) { console.warn("[poker] snapshot failed", e); }
      if (!stopped) setTimeout(tick, intervalMs);
    };
    tick();
    return () => { stopped = true; };
  }
}

export const fmt = (wei, dp = 2) => Number(ethers.formatEther(wei)).toFixed(dp);
