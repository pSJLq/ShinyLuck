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
  "function rakeCollected() view returns (uint256)",
  "function withdrawRake(address,uint256)",
  "function owner() view returns (address)",
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
  "function info(uint256) view returns (address creator,uint128 buyIn,uint128 fee,uint128 startStack,uint128 pool,uint8 maxPlayers,uint8 registered,uint8 status,uint8 remaining,uint256 tableId,uint16[] payoutBps,bool approvalRequired,uint8 pendingCount)",
  "function clock(uint256) view returns (uint64 startedAt,uint8 level,uint64 levelDur,uint128 curSb,uint128 curBb,uint128 curAnte,uint64 startTime)",
  "function isRegistered(uint256,address) view returns (bool)",
  "function hostBpsOf(uint256) view returns (uint16)",
  "function isPending(uint256,address) view returns (bool)",
  "function pendingEntries(uint256) view returns (address[])",
  "function playersOf(uint256) view returns (address[])",
  "function tablesOf(uint256) view returns (uint256[])",
  "function structureOf(uint256) view returns ((uint128 sb,uint128 bb,uint128 ante,uint32 durationSecs)[])",
  "function dueForLevelUp(uint256) view returns (bool)",
  "function createTournament((uint128 buyIn,uint128 fee,uint8 maxPlayers,uint8 seatsPerTable,uint128 startStack,uint128 sbStart,uint128 bbStart,uint128 anteStart,uint64 levelDur,uint16 growthBps,uint64 startTime,bool approvalRequired,uint32 actionSecs,uint16[] payoutBps,(uint128 sb,uint128 bb,uint128 ante,uint32 durationSecs)[] structure,uint16 hostBps) p) payable returns (uint256)",
  "function register(uint256) payable",
  "function unregister(uint256)",
  "function approveEntry(uint256,address)",
  "function rejectEntry(uint256,address)",
  "function withdrawApplication(uint256)",
  "function start(uint256)",
  "function cancel(uint256)",
  "function owner() view returns (address)",
  "function feeCollected() view returns (uint256)",
  "function withdrawFees(address,uint256)",
];

// Fully on-chain uploaded avatars — see contracts/poker/AvatarStore.sol.
const AV_ABI = [
  "function setAvatar(bytes data)",
  "function clearAvatar()",
  "function avatarOf(address) view returns (bytes)",
  "function hasAvatar(address) view returns (bool)",
];

// On-chain player profiles (nicknames) — see contracts/poker/PlayerProfile.sol.
const PP_ABI = [
  "function setProfile(string handle,uint16 avatar)",
  "function clearHandle()",
  "function handleOf(address) view returns (string)",
  "function hasHandle(address) view returns (bool)",
  "function addressOfHandle(string) view returns (address)",
  "function handleAvailable(string) view returns (bool)",
  "function profileOf(address) view returns (string handle,uint16 avatar,uint64 since)",
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
    // zkShuffle v2 rooms read their cards from ZkTableDealer — same IPokerDealer
    // views, so the whole table UI works unchanged. cardLayer is written by the
    // deploy script; a config with a zk address but cardLayer!=="zk" is a v1
    // room with the experimental verifier alongside (the zk-lab page).
    this.zkLayer = cfg.cardLayer === "zk" && !!cfg.zkTableDealer;
    this.dealerRead = this.zkLayer
      ? new ethers.Contract(cfg.zkTableDealer, DEALER_ABI, this.read)
      : cfg.commitRevealDealer ? new ethers.Contract(cfg.commitRevealDealer, DEALER_ABI, this.read) : null;
    this.trnRead = cfg.pokerTournament ? new ethers.Contract(cfg.pokerTournament, TRN_ABI, this.read) : null;
    this.ppRead = cfg.playerProfile ? new ethers.Contract(cfg.playerProfile, PP_ABI, this.read) : null;
    this.avRead = cfg.avatarStore ? new ethers.Contract(cfg.avatarStore, AV_ABI, this.read) : null;
    this.avWrite = null;
    this.trnWrite = null;
    this.ppWrite = null;
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
    this.ppWrite = this.cfg.playerProfile ? new ethers.Contract(this.cfg.playerProfile, PP_ABI, this.signer) : null;
    this.avWrite = this.cfg.avatarStore ? new ethers.Contract(this.cfg.avatarStore, AV_ABI, this.signer) : null;
  }

  async _attachPrivy(address) {
    const { PrivySigner } = await import("/lib/privy-signer.js");
    this.signer = new PrivySigner(address, this.read);
    this.address = address;
    this._bindWrites();
    this.backend = "privy";
    if (typeof this.signer.prewarm === "function") this.signer.prewarm();
  }

  _privyWait(pred, ms = 45000) {
    // The Privy bundle is ~4.6MB + an iframe handshake with auth.privy.io — a
    // cold load can take well over the old 8s, which surfaced as a bogus
    // "Privy timeout" when users clicked Connect right after page load.
    return new Promise((resolve, reject) => {
      const finish = (ok) => { clearTimeout(t); clearInterval(iv); document.removeEventListener("shinyluck:auth-state", on); ok ? resolve() : reject(new Error("Email login is still loading — give it a few seconds and try again (or use MetaMask)."));
      };
      const t = setTimeout(() => finish(false), ms);
      const check = () => { const a = window.ShinyLuckAuth; return !!(a && pred({ ready: a.ready, authenticated: a.authenticated, address: a.address })); };
      const on = (ev) => { if (pred(ev.detail || {}) || check()) finish(true); };
      document.addEventListener("shinyluck:auth-state", on);
      // Poll as a safety net — the ready flip can land before our listener attaches.
      const iv = setInterval(() => { if (check()) finish(true); }, 400);
      if (check()) finish(true);
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
    const ACC = "#d9ab4a", ACC2 = "#f2d78a";
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

  /// First table (≠ excludeTable) where this address currently holds a seat;
  /// -1 if none. One-table-at-a-time guard for the sit-down flow — covers cash
  /// AND running-tournament seats. IMPORTANT: a tournament WINNER's seat stays
  /// occupied on the controlled table forever (the contract never stands the
  /// last player up) — a FINISHED event's ghost seat must not block cash play.
  async seatedTableAt(excludeTable = -1) {
    if (!this.address) return -1;
    const n = await this.tableCount();
    const checks = await Promise.all(Array.from({ length: n }, (_, t) =>
      t === excludeTable ? Promise.resolve(255) : this.roomRead.seatOf(t, this.address).then(Number).catch(() => 255)));
    for (let t = 0; t < n; t++) {
      if (checks[t] === 255) continue;
      try {
        const ctl = await this.roomRead.tableController(t);
        if (ctl !== ethers.ZeroAddress) {
          const trn = await this.tournamentOfTable(t);
          if (!trn || trn.status >= 2) continue; // finished/orphaned event — ghost seat, not a live game
        }
      } catch {}
      return t;
    }
    return -1;
  }

  /// Native STT/SOMI balance of the connected wallet (for funding guidance).
  async walletBalance() { return this.address ? this.read.getBalance(this.address) : 0n; }

  // ---- tournaments ----
  hasTournaments() { return !!this.trnRead; }

  async tournamentCount() { return this.trnRead ? Number(await this.trnRead.count()) : 0; }

  async tournamentInfo(id) {
    const [i, hostBps] = await Promise.all([
      this.trnRead.info(id),
      this.trnRead.hostBpsOf(id).then(Number).catch(() => 0), // pre-v3 contracts have no host reward
    ]);
    return {
      id, creator: i.creator, buyIn: i.buyIn, fee: i.fee, startStack: i.startStack, pool: i.pool,
      maxPlayers: Number(i.maxPlayers), registered: Number(i.registered), status: Number(i.status),
      remaining: Number(i.remaining), tableId: Number(i.tableId), payoutBps: i.payoutBps.map(Number),
      approvalRequired: i.approvalRequired, pendingCount: Number(i.pendingCount), hostBps,
    };
  }

  async tournaments() {
    // dealer cache first — one GET instead of N info() calls per lobby client
    const lob = await this.lobbySnapshot();
    if (lob && Array.isArray(lob.tournaments)) {
      return lob.tournaments.map((t) => ({
        id: Number(t.id), creator: t.creator, buyIn: BigInt(t.buyIn || 0), fee: BigInt(t.fee || 0),
        startStack: BigInt(t.startStack || 0), pool: BigInt(t.pool || 0),
        maxPlayers: Number(t.maxPlayers), registered: Number(t.registered), status: Number(t.status),
        remaining: Number(t.remaining), tableId: Number(t.tableId), payoutBps: (t.payoutBps || []).map(Number),
        approvalRequired: !!t.approvalRequired, pendingCount: Number(t.pendingCount || 0), hostBps: Number(t.hostBps || 0),
      }));
    }
    const n = await this.tournamentCount();
    const ids = Array.from({ length: n }, (_, i) => i);
    return Promise.all(ids.map((i) => this.tournamentInfo(i)));
  }

  async tournamentClock(id, at) {
    const c = await (at ? this._trnAt(at) : this.trnRead).clock(id);
    return { startedAt: Number(c.startedAt), level: Number(c.level), levelDur: Number(c.levelDur), curSb: c.curSb, curBb: c.curBb, curAnte: c.curAnte, startTime: Number(c.startTime) };
  }

  /// `at` targets the table's controller contract (survives a stale poker-config
  /// after a tournament redeploy — same rationale as _trnAt).
  async isRegisteredIn(id, at) { return this.address ? (at ? this._trnAt(at) : this.trnRead).isRegistered(id, this.address) : false; }

  /// Read-only tournament contract at an arbitrary address (cached). The table's
  /// on-chain CONTROLLER is the source of truth — a stale cached poker-config
  /// after a tournament redeploy must never demote a tournament table to cash mode.
  _trnAt(addr) {
    if (!this._trnAtCache) this._trnAtCache = new Map();
    const k = addr.toLowerCase();
    if (!this._trnAtCache.has(k)) this._trnAtCache.set(k, new ethers.Contract(addr, TRN_ABI, this.read));
    return this._trnAtCache.get(k);
  }

  /// Find the tournament that controls `tableId` (or null for a cash table).
  /// MTT-aware: matches any of the tournament's tables, not just tables[0].
  async tournamentOfTable(tableId) {
    if (!this.roomRead) return null;
    const ctl = await this.roomRead.tableController(tableId);
    if (ctl === ethers.ZeroAddress) return null;
    const trn = this._trnAt(ctl);
    let fallback = null;
    try {
      const n = Number(await trn.count());
      for (let i = n - 1; i >= 0; i--) {
        const x = await trn.info(i);
        const t = {
          id: i, at: ctl, creator: x.creator, buyIn: x.buyIn, fee: x.fee, startStack: x.startStack, pool: x.pool,
          maxPlayers: Number(x.maxPlayers), registered: Number(x.registered), status: Number(x.status),
          remaining: Number(x.remaining), tableId: Number(x.tableId), payoutBps: x.payoutBps.map(Number),
          approvalRequired: x.approvalRequired, pendingCount: Number(x.pendingCount),
        };
        let tbls = null;
        try { tbls = (await trn.tablesOf(i)).map(Number); } catch {}
        const mine = t.tableId === tableId || (tbls || []).includes(tableId);
        if (!mine) continue;
        t.tables = tbls && tbls.length ? tbls : [t.tableId];
        if (t.status === 1) return t;
        if (!fallback) fallback = t;
      }
    } catch { return fallback; }
    return fallback;
  }

  /// Create a tournament. buyIn/fee/sponsor in ether units; chips/blinds/ante are
  /// plain tournament-chip integers; growthBps = blind/ante growth per level
  /// (20000 = ×2); startTime = unix seconds (0 = manual/when-full);
  /// approvalRequired = private game (entries wait for the creator); payoutBps
  /// must sum to 10000.
  async createTournament({ buyInEth = 0, feeEth = 0, maxPlayers, seatsPerTable = 0, startStack, sbStart = 10, bbStart = 20, anteStart = 0, levelDur = 300, growthBps = 20000, startTime = 0, approvalRequired = false, actionSecs = 0, payoutBps, structure = [], sponsorEth = 0, hostBps = 0 }) {
    this.requireWallet();
    if (!this.trnWrite) throw new Error("tournaments not deployed");
    const p = {
      buyIn: ethers.parseEther(String(buyInEth)),
      fee: ethers.parseEther(String(feeEth)),
      maxPlayers,
      seatsPerTable,
      startStack: BigInt(startStack),
      sbStart: BigInt(sbStart),
      bbStart: BigInt(bbStart),
      anteStart: BigInt(anteStart),
      levelDur: BigInt(levelDur),
      growthBps,
      startTime: BigInt(startTime),
      approvalRequired,
      actionSecs: Number(actionSecs) || 0,
      payoutBps,
      structure: (structure || []).map((l) => ({ sb: BigInt(l.sb), bb: BigInt(l.bb), ante: BigInt(l.ante || 0), durationSecs: Number(l.durationSecs) })),
      hostBps: Number(hostBps) || 0,
    };
    return (await this.trnWrite.createTournament(p, { value: ethers.parseEther(String(sponsorEth)) })).wait();
  }

  async registerTournament(id, costWei) {
    this.requireWallet();
    return (await this.trnWrite.register(id, { value: costWei })).wait();
  }

  async unregisterTournament(id) { this.requireWallet(); return (await this.trnWrite.unregister(id)).wait(); }
  async startTournament(id) { this.requireWallet(); return (await this.trnWrite.start(id)).wait(); }
  async cancelTournament(id) { this.requireWallet(); return (await this.trnWrite.cancel(id)).wait(); }

  /// The controller of a table (a tournament address, or zero for a cash table).
  async tableController(t) { try { return await this.roomRead.tableController(t); } catch { return ethers.ZeroAddress; } }

  /// Tables a tournament runs on (1 for SNG, several for MTT).
  async tournamentTables(id, at) { try { return (await (at ? this._trnAt(at) : this.trnRead).tablesOf(id)).map(Number); } catch { return []; } }

  /// Custom blind schedule (immutable after create → cached). [] = geometric growth.
  async tournamentStructure(id, at) {
    if (!this._structCache) this._structCache = new Map();
    const key = (at ? at.toLowerCase() + ":" : "") + id;
    if (this._structCache.has(key)) return this._structCache.get(key);
    let out = [];
    try { out = (await (at ? this._trnAt(at) : this.trnRead).structureOf(id)).map((l) => ({ sb: Number(l.sb), bb: Number(l.bb), ante: Number(l.ante), durationSecs: Number(l.durationSecs) })); } catch {}
    if (out.length) this._structCache.set(key, out); // don't cache empty pre-deploy reads
    return out;
  }

  /// Unix time the NEXT blind level is due (null when on the last level /
  /// not running). Structure-aware — custom schedules have per-level durations.
  async nextLevelAt(id, clock, at) {
    const c = clock || (await this.tournamentClock(id, at));
    if (!c.startedAt) return null;
    const s = await this.tournamentStructure(id, at);
    if (s.length) {
      // Past the schedule the blinds keep escalating (overtime levels run as
      // long as the final scheduled level) — mirrors _timeForNextLevel on-chain.
      let due = c.startedAt;
      for (let i = 0; i <= c.level && i < s.length; i++) due += s[i].durationSecs;
      if (c.level + 1 > s.length) due += (c.level + 1 - s.length) * s[s.length - 1].durationSecs;
      return due;
    }
    return c.startedAt + (c.level + 1) * c.levelDur;
  }

  // ---- owner: tournament fees (10% platform cut of buy-ins) ----
  async trnOwner() { try { return await this.trnRead.owner(); } catch { return ethers.ZeroAddress; } }
  async trnFeesCollected() { try { return await this.trnRead.feeCollected(); } catch { return 0n; } }
  async withdrawAllTrnFees(to) { this.requireWallet(); const amt = await this.trnRead.feeCollected(); return (await this.trnWrite.withdrawFees(to, amt)).wait(); }
  /// The table where the connected player currently sits in a (possibly multi-table) tournament.
  async myTournamentTable(id) {
    const strict = await this.myTournamentSeatTable(id);
    if (strict >= 0) return strict;
    const tables = await this.tournamentTables(id);
    return tables.length ? tables[0] : null;
  }

  /// STRICT variant: the table where I actually hold a seat, or -1 (busted /
  /// not playing). The table page tells "moved to another table" from "busted"
  /// with this — the fallback above would mask both.
  async myTournamentSeatTable(id, at) {
    if (!this.address) return -1;
    const tables = await this.tournamentTables(id, at);
    for (const tid of tables) {
      try { if (Number(await this.roomRead.seatOf(tid, this.address)) !== 255) return tid; } catch {}
    }
    return -1;
  }

  /// Finishing places / prizes / rebalance moves from the dealer bot's event
  /// indexer (Busted/Finished/PlayerMoved exist only as events — no on-chain
  /// view). null → indexer unavailable; callers degrade gracefully.
  async tournamentResults(id) {
    if (!this.cfg.dealerApiUrl) return null;
    try {
      const r = await fetch(`${this.cfg.dealerApiUrl}/trnhist?id=${id}`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) return null;
      const raw = await r.json();
      return {
        busts: (raw.busts || []).map((b) => ({ player: b.player, place: Number(b.place), prize: BigInt(b.prize || 0) })),
        winner: raw.winner ? { player: raw.winner.player, prize: BigInt(raw.winner.prize || 0) } : null,
        moves: raw.moves || [],
      };
    } catch { return null; }
  }

  // ---- approval flow (private games: creator admits applicants) ----
  async approveEntry(id, player) { this.requireWallet(); return (await this.trnWrite.approveEntry(id, player)).wait(); }
  async rejectEntry(id, player) { this.requireWallet(); return (await this.trnWrite.rejectEntry(id, player)).wait(); }
  async withdrawApplication(id) { this.requireWallet(); return (await this.trnWrite.withdrawApplication(id)).wait(); }
  async pendingEntries(id) { return this.trnRead ? this.trnRead.pendingEntries(id) : []; }
  async isPendingIn(id) { return this.address ? this.trnRead.isPending(id, this.address) : false; }
  async tournamentPlayers(id) { return this.trnRead ? this.trnRead.playersOf(id) : []; }

  // ---- on-chain player profiles (nicknames) ----
  hasProfiles() { return !!this.ppRead; }
  async setProfile(handle, avatar = 0) {
    this.requireWallet();
    if (!this.ppWrite) throw new Error("profiles not deployed");
    const r = await (await this.ppWrite.setProfile(handle, avatar)).wait();
    // my own cached profile is stale now — next poll re-reads it
    if (this.address && this._profCache) this._profCache.delete(this.address.toLowerCase());
    return r;
  }
  async handleOf(addr) { try { return this.ppRead ? await this.ppRead.handleOf(addr) : ""; } catch { return ""; } }
  async myHandle() { return this.address ? this.handleOf(this.address) : ""; }
  async profileOf(addr) {
    if (!this.ppRead) return { handle: "", avatar: 0, since: 0 };
    try { const p = await this.ppRead.profileOf(addr); return { handle: p.handle, avatar: Number(p.avatar), since: Number(p.since) }; }
    catch { return { handle: "", avatar: 0, since: 0 }; }
  }
  async handleAvailable(handle) { try { return this.ppRead ? await this.ppRead.handleAvailable(handle) : false; } catch { return false; } }
  /// Resolve nicknames for a set of addresses (per-address cache — safe to call
  /// every poll; only unknown addresses hit the chain). → { lowercased addr: handle }
  async handlesFor(addrs) {
    const m = await this.profilesFor(addrs);
    const out = {};
    for (const a of Object.keys(m)) out[a] = m[a].handle;
    return out;
  }

  /// Full profiles (nickname + preset avatar id + uploaded on-chain image as a
  /// data URI) for a set of addresses, cached per address. The image is raw
  /// bytes in AvatarStore — sniff the magic for the MIME.
  /// → { lowercased addr: {handle, avatar, img|null} }
  async profilesFor(addrs) {
    if (!this._profCache) this._profCache = new Map();
    const out = {};
    await Promise.all([...new Set((addrs || []).filter(Boolean).map((a) => a.toLowerCase()))].map(async (a) => {
      if (!this._profCache.has(a)) {
        let p = { handle: "", avatar: 0, img: null };
        try { if (this.ppRead) { const r = await this.ppRead.profileOf(a); p.handle = r.handle; p.avatar = Number(r.avatar); } } catch {}
        try {
          if (this.avRead) {
            const raw = ethers.getBytes(await this.avRead.avatarOf(a));
            if (raw.length > 0) p.img = this._bytesToDataUri(raw);
          }
        } catch {}
        this._profCache.set(a, p);
      }
      out[a] = this._profCache.get(a);
    }));
    return out;
  }

  _bytesToDataUri(raw) {
    const mime = raw[0] === 0xff && raw[1] === 0xd8 ? "image/jpeg"
      : raw[0] === 0x89 && raw[1] === 0x50 ? "image/png"
      : "image/webp"; // RIFF….WEBP and anything else the canvas produced
    let bin = "";
    for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
    return `data:${mime};base64,${btoa(bin)}`;
  }

  /// Upload my avatar image (raw bytes, ≤8KB — the UI compresses first).
  async setAvatarImage(bytes) {
    this.requireWallet();
    if (!this.avWrite) throw new Error("avatar store not deployed");
    const r = await (await this.avWrite.setAvatar(bytes)).wait();
    if (this.address && this._profCache) this._profCache.delete(this.address.toLowerCase());
    return r;
  }

  async clearAvatarImage() {
    this.requireWallet();
    if (!this.avWrite) throw new Error("avatar store not deployed");
    const r = await (await this.avWrite.clearAvatar()).wait();
    if (this.address && this._profCache) this._profCache.delete(this.address.toLowerCase());
    return r;
  }

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
  /// v2 deals have no seed — every card is individually proven on-chain, so the
  /// widget gets a zk-flavored object instead.
  async dealCommit(dealId) {
    if (!this.dealerRead || !dealId || dealId === 0n) return null;
    if (this.zkLayer) {
      const revealed = await this.dealerRead.isShowdownReady(dealId).catch(() => false);
      return { zk: true, dealId: String(dealId), revealed };
    }
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

  /// Snapshot with the dealer's HTTP cache as the primary source: one GET
  /// instead of ~14 RPC calls per tick, so hundreds of watchers don't melt the
  /// public RPC. Any failure/staleness falls back to direct chain reads and the
  /// dealer path is retried after a cool-down — the table NEVER goes blind.
  async snapshotSmart(t) {
    if (this.cfg.dealerApiUrl && Date.now() >= (this._snapSrcDownUntil || 0)) {
      try {
        const r = await fetch(`${this.cfg.dealerApiUrl}/snapshot?t=${t}`, { signal: AbortSignal.timeout(2500) });
        if (r.ok) {
          const raw = await r.json();
          if (Date.now() - raw.ts < 8000) return this._hydrateSnapshot(raw);
        }
      } catch {}
      this._snapSrcDownUntil = Date.now() + 30_000;
    }
    return this.snapshot(t);
  }

  /// Rebuild the exact snapshot() shape from the dealer's JSON (BigInts arrive
  /// as strings).
  _hydrateSnapshot(raw) {
    const B = (x) => BigInt(x || 0);
    const cfg = {
      maxSeats: Number(raw.cfg.maxSeats), smallBlind: B(raw.cfg.smallBlind), bigBlind: B(raw.cfg.bigBlind),
      ante: B(raw.cfg.ante), minBuyIn: B(raw.cfg.minBuyIn), maxBuyIn: B(raw.cfg.maxBuyIn),
      rakeBps: Number(raw.cfg.rakeBps), rakeCap: B(raw.cfg.rakeCap),
      actionTimeout: Number(raw.cfg.actionTimeout), active: !!raw.cfg.active,
    };
    const hand = {
      handId: Number(raw.hand.handId), street: Number(raw.hand.street), button: Number(raw.hand.button),
      actingSeat: Number(raw.hand.actingSeat), numInHand: Number(raw.hand.numInHand),
      currentBet: B(raw.hand.currentBet), minRaise: B(raw.hand.minRaise), pot: B(raw.hand.pot),
      actingDeadline: Number(raw.hand.actingDeadline), dealId: B(raw.hand.dealId), inProgress: !!raw.hand.inProgress,
    };
    const seats = raw.seats.map((s) => ({
      index: Number(s.index), player: s.player, occupied: !!s.occupied, sittingOut: !!s.sittingOut,
      stack: B(s.stack), empty: s.player === ethers.ZeroAddress,
      inHand: !!s.inHand, folded: !!s.folded, allIn: !!s.allIn, committedStreet: B(s.committedStreet),
    }));
    const mySeat = this.address ? seats.findIndex((s) => s.player.toLowerCase() === this.address.toLowerCase()) : -1;
    return { tableId: Number(raw.tableId), cfg, hand, seats, board: (raw.board || []).map(Number), mySeat };
  }

  /// The lobby feed from the dealer cache (tables + tournaments in one GET).
  /// null → caller falls back to per-table chain reads.
  async lobbySnapshot() {
    if (!this.cfg.dealerApiUrl) return null;
    try {
      const r = await fetch(`${this.cfg.dealerApiUrl}/lobby`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) return null;
      const raw = await r.json();
      if (Date.now() - raw.ts > 20_000) return null;
      return raw;
    } catch { return null; }
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

  /// Message the zk agent signs once per deal to authenticate protocol calls.
  zkMessage(t, dealId) { return `ShinyPoker:zk:${t}:${dealId}`; }

  async signZk(t, dealId) {
    const msg = this.zkMessage(t, dealId);
    if (this.sessionActive && this.sessionWallet) return this.sessionWallet.signMessage(msg);
    this.requireWallet();
    return this.signer.signMessage(msg);
  }

  /// This player's two hole cards. v2 (zk) tables: the cards were decrypted
  /// LOCALLY by zk-agent.js — the dealer never had them; we just read the
  /// agent's cache (the caller already retries until they land). v1 tables:
  /// ask the off-chain dealer (signature-gated).
  async myHoleCards(t, dealId, signature) {
    if (this.zkLayer) {
      const h = (typeof window !== "undefined" && window.__SPZK && window.__SPZK.holes) ? window.__SPZK.holes[String(dealId)] : null;
      if (h) return h;
      throw new Error("decrypting your cards…");
    }
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
  async roomOwner() { try { return await this.roomRead.owner(); } catch { return ethers.ZeroAddress; } }
  async rakeCollected() { try { return await this.roomRead.rakeCollected(); } catch { return 0n; } }
  async withdrawRake(to, amountEth) { this.requireWallet(); return (await this.roomWrite.withdrawRake(to, ethers.parseEther(String(amountEth)))).wait(); }
  async withdrawAllRake(to) { this.requireWallet(); const amt = await this.roomRead.rakeCollected(); return (await this.roomWrite.withdrawRake(to, amt)).wait(); }
  /// Cash out: send native STT from the connected wallet to any external address.
  async sendNative(to, amountEth) { this.requireWallet(); return (await this.signer.sendTransaction({ to, value: ethers.parseEther(String(amountEth)) })).wait(); }
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
      try { cb(await this.snapshotSmart(t)); } catch (e) { console.warn("[poker] snapshot failed", e); }
      if (!stopped) setTimeout(tick, intervalMs);
    };
    tick();
    return () => { stopped = true; };
  }
}

export const fmt = (wei, dp = 2) => Number(ethers.formatEther(wei)).toFixed(dp);
