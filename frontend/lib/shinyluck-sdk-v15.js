// ShinyLuck SDK v15 — modular casino (CasinoVault + per-game modules).
//
// The v14 SDK talked to one monolithic Casino contract with a bespoke method
// per game. v15 keeps the same PUBLIC method names so pages barely change, but
// routes each call to the right place:
//   single-shot (dice, plinko) → vault.placeBet(gameId, clientSeed, params)
//   slots       (vault7, cluster) → module.placeSpin / buyBonus
//   mines       → module.placeMinesBet / pickCell / cashout / cancelPick
//   rounds      (crash, roulette) → module.startRound / placeBet(s) / requestCashout
// Money always lives in the Vault: balances, claims and history come from there.
//
// Addresses come from the deployment manifest (deployments/<net>-v15.json), so
// adding a game later needs NO SDK redeploy — it appears in `manifest.games`.
import { ethers } from "/vendor/ethers.bundle.js";
import { CHAINS } from "./shinyluck-sdk.js";

export const GAME = { DICE: 0, CRASH: 1, SLOTS: 2, MINES: 3, PLINKO: 4, ROULETTE: 5, CLUSTER: 6 };
export const ROULETTE_KIND = {
  STRAIGHT: 0, RED: 1, BLACK: 2, EVEN: 3, ODD: 4, LOW: 5, HIGH: 6,
  DOZEN_1: 7, DOZEN_2: 8, DOZEN_3: 9,
};

const VAULT_ABI = [
  "function placeBet(uint16 id, bytes32 clientSeed, bytes params) payable returns (uint256)",
  "function revealAndSettle(uint256 betId, bytes32 serverSeed)",
  "function refundExpired(uint256 betId)",
  "function claim()",
  "function totalBets() view returns (uint256)",
  "function getBet(uint256 betId) view returns (tuple(address player,uint96 amount,uint16 gameId,uint8 status,uint64 commitBlock,uint64 nonce,uint256 seedIdx,bytes32 clientSeed,bytes params,bytes32 randomness,uint128 payout,bool won))",
  "function getPlayerBets(address player) view returns (uint256[])",
  "function pendingWithdrawals(address) view returns (uint256)",
  "function freeBankroll() view returns (uint256)",
  "function maxBetBps() view returns (uint256)",
  "function gameModule(uint16) view returns (address)",
  "function gameActive(uint16) view returns (bool)",
  "function gameMaxBet(uint16) view returns (uint256)",
  "event BetPlaced(uint256 indexed betId, address indexed player, uint16 indexed gameId, uint256 amount, bytes32 clientSeed, uint256 commitBlock, uint256 seedIdx, bytes params)",
  "event BetSettled(uint256 indexed betId, address indexed player, uint16 indexed gameId, bool won, uint256 payout, bytes32 randomness, bytes32 serverSeed, bytes32 clientSeed, bytes32 blockHash, uint256 nonce, bytes resultData)",
];

const SLOT_ABI = [
  "function placeSpin(bytes32 clientSeed, bool useFreeSpin) payable returns (uint256)",
  "function buyBonus(bytes32 clientSeed) payable returns (uint256)",
  "function totalSpins() view returns (uint256)",
  "function getSpin(uint256 betId) view returns (tuple(address player,uint96 amount,uint8 status,bool freeSpin,bool buyBonus,uint64 commitBlock,uint64 nonce,uint256 seedIdx,bytes32 clientSeed,bytes32 randomness,uint128 payout))",
  "function reportedRtpBps() view returns (uint16)",
  "function payBoostX100() view returns (uint256)",
  "event SpinPlaced(uint256 indexed betId, address indexed player, uint256 amount, bool freeSpin, bool buyBonus)",
  "event SpinSettled(uint256 indexed betId, address indexed player, bool won, uint256 payout, bytes32 randomness, bytes32 serverSeed, bytes resultData)",
];

const CLUSTER_EXTRA_ABI = [
  "function claimChargeReward()",
  "function getChargeMeter(address player) view returns (uint256 current, uint256 threshold, uint256 pendingReward, uint8 cycle)",
  // The meter lives on the SUGAR.LAB module, so these are the only events that
  // can tell the page it fired. Parsing them with the Vault interface (what the
  // page used to do) silently matched nothing, and the meter appeared to just
  // reset itself for no reason.
  "event ChargeMeterBumped(address indexed player, uint256 newCharge, uint256 threshold)",
  "event ChargeMeterTriggered(address indexed player, uint8 rewardId, uint256 amount, uint8 cycle)",
  "event ChargeRewardClaimed(address indexed player, uint256 amount)",
];

const MINES_ABI = [
  "function placeMinesBet(uint8 mineCount, bytes32 clientSeed) payable returns (uint256)",
  "function pickCell(uint256 betId, uint8 cellIdx)",
  "function cancelPick(uint256 betId)",
  "function cashout(uint256 betId)",
  "function totalGames() view returns (uint256)",
  "function getGame(uint256 betId) view returns (tuple(address player,uint96 amount,uint8 status,uint8 mineCount,uint8 pendingCell,bool busted,bool finalized,uint32 openedBitmap,uint64 commitBlock,uint64 pickBlock,uint64 nonce,uint256 seedIdx,bytes32 clientSeed,bytes32 layoutRoot,bytes32 entropyHash,bytes32 randomness))",
  "event MinesPlaced(uint256 indexed betId, address indexed player, uint256 amount, uint8 mineCount)",
  "event MinesRootCommitted(uint256 indexed betId, bytes32 root)",
  "event MinesCellOpened(uint256 indexed betId, uint8 cellIdx, uint32 openedBitmap, uint256 multiplierX100)",
  "event MinesBust(uint256 indexed betId, uint8 cellIdx)",
  "event MinesCashout(uint256 indexed betId, uint8 cellsOpened, uint256 payout, uint256 multiplierX100)",
  "event MinesLayout(uint256 indexed betId, uint32 minesBitmap, bytes32 serverSeed)",
];

const CRASH_ABI = [
  "function startRound()",
  "function placeBet(uint256 autoCashoutX100) payable",
  "function requestCashout(uint256 multX100)",
  "function hasOpenRound() view returns (bool)",
  "function currentRoundId() view returns (uint256)",
  "function totalRounds() view returns (uint256)",
  "function getRound(uint256 roundId) view returns (uint64 id, uint64 betWindowEnd, uint64 commitBlock, uint32 seedIdx, bool settled, uint16 crashPointX100, bytes32 serverSeed, uint256 bettorCount)",
  "function getBet(uint256 roundId, address player) view returns (tuple(uint96 amount,uint16 autoCashoutX100,uint16 cashoutMultX100,bool resolved))",
  "event RoundSettled(uint256 indexed roundId, uint256 crashPointX100, bytes32 serverSeed, bytes32 randomness, bytes32 blockHash)",
];

const ROULETTE_ABI = [
  "function startRound()",
  "function placeBets(tuple(uint8 kind, uint8 number, uint96 amount)[] bets) payable",
  "function hasOpenRound() view returns (bool)",
  "function currentRoundId() view returns (uint256)",
  "function totalRounds() view returns (uint256)",
  "function getRound(uint256 roundId) view returns (uint64 id, uint64 betWindowEnd, uint64 commitBlock, uint32 seedIdx, bool settled, uint8 resultNumber, bytes32 serverSeed, uint256 bettorCount)",
  "function getBets(uint256 roundId, address player) view returns (tuple(uint8 kind, uint8 number, uint96 amount)[])",
  "event RoundSettled(uint256 indexed roundId, uint8 resultNumber, bytes32 serverSeed, bytes32 randomness)",
];

const LOYALTY_ABI = [
  "function available(address) view returns (uint256)",
  "function getPlayerSlotState(address p) view returns (uint64 total, uint64 earned, uint64 used, uint256 toNext)",
];

export class ShinyLuckV15 {
  /**
   * @param {object} o
   * @param {object} o.manifest  deployments/<net>-v15.json (vault + games[])
   * @param {object} o.provider  read provider (rpc proxy)
   * @param {object} [o.signer]  write signer (PrivySigner); set later via setSigner
   */
  constructor({ manifest, provider = null, signer = null, network = null }) {
    this.manifest = manifest;
    this.network = network || CHAINS.somniaTestnet;
    // v15 has no PlayerAgentRegistry (the agent layer was dropped). Kept as an
    // explicit null so `if (SL.registry)` guards read false instead of throwing.
    this.registry = null;
    // Slot/mines bet ids are LOCAL to their module, so a bare id is ambiguous.
    // Remember what each placed id belongs to, and waitForSettle can route it.
    this._spinIndex = new Map();
    this.provider = provider;
    this.signer = signer;
    // Plain property (NOT a getter): wallet.js assigns `SL.address = ...`
    // after Privy sign-in, exactly as it does for the v14 SDK.
    this.address = signer?.address || null;
    this.games = Object.fromEntries(manifest.games.map((g) => [g.name, g]));
    this.vault = null;
    this.loyalty = null;
    if (provider) this._rebuildContracts();
  }

  /// Rebuild read contracts against the current provider. Mirrors the v14 SDK
  /// hook so wallet.js can drive both the same way:
  ///   SL.provider = ro; SL.signer = new PrivySigner(...); SL._rebuildContracts()
  _rebuildContracts() {
    const p = this.provider || this.signer;
    if (!p) throw new Error("ShinyLuckV15: no provider/signer set");
    this.vault = new ethers.Contract(this.manifest.addresses.vault, VAULT_ABI, p);
    // `casino` facade: pages written against the v14 monolith call
    // SL.casino.<x>. Most of those (getBet/claim/getPlayerBets/freeBankroll)
    // are Vault methods and pass straight through; the few that moved to other
    // contracts in v15 are re-routed here, so no page markup has to change.
    this.casino = this._makeCasinoFacade();
    this.loyalty = this.manifest.addresses.loyalty
      ? new ethers.Contract(this.manifest.addresses.loyalty, LOYALTY_ABI, p)
      : null;
  }

  /// Proxy over the Vault contract that also answers the handful of v14-era
  /// names whose implementation moved to another contract in v15.
  _makeCasinoFacade() {
    const self = this;
    const extra = {
      // `vault` is built on the READ provider, so every write reached through
      // this facade would die with UNSUPPORTED_OPERATION ("contract runner does
      // not support sending transactions"). Route the one write v14 pages call
      // through the signer-bound instance instead.
      claim: () => self._vaultW().claim(),
      // Loyalty counters moved to the shared SlotLoyalty contract.
      freeSpinsAvailable: (addr) => (self.loyalty ? self.loyalty.available(addr) : Promise.resolve(0n)),
      getPlayerSlotState: (addr) => self.loyalty?.getPlayerSlotState(addr),
      // Charge meter belongs to the SUGAR.LAB module.
      getChargeMeter: (addr) =>
        self._mod("cluster", [...SLOT_ABI, ...CLUSTER_EXTRA_ABI]).getChargeMeter(addr),
      // Reported RTP. NOT read from the module: its reportedRtpBps() is a
      // LINEAR formula (base x boost), but the SUGAR.LAB charge meter
      // contributes ~13.8% of RTP and does not scale with the boost, so the
      // formula is wrong by 1-2 points. These are the MEASURED values from
      // scripts/validate-rtp.js at the boosts actually deployed
      // (vault7 payBoostX100=589 -> 96.42%, cluster=340 -> 96.38%,
      //  SEED=calib-v15, N=500 000). Re-measure and update here whenever a
      // boost changes; the module's own getter stays as telemetry only.
      //
      // Only the two slots need the measured override. Every other game is a
      // flat edge the module states itself, so read it instead of answering
      // 96.42% for dice (really 99%), plinko, crash, roulette and mines.
      getReportedRTP: async (gameId) => {
        const id = Number(gameId);
        if (id === GAME.CLUSTER) return 9638n;
        if (id === GAME.SLOTS) return 9642n;
        const g = (self.manifest.games || []).find((x) => Number(x.id) === id);
        if (!g) return 0n;
        const c = new ethers.Contract(
          g.module, ["function houseEdgeBps() view returns (uint16)"], self.provider || self.signer,
        );
        return 10000n - BigInt(await c.houseEdgeBps());
      },
    };
    return new Proxy(this.vault, {
      get(target, prop, recv) {
        if (prop in extra) return extra[prop];
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  setSigner(signer) {
    this.signer = signer;
    this.address = signer?.address || this.address;
  }

  /** Module contract for a game name, bound to signer when writing. */
  _mod(name, abi, write = false) {
    const g = this.games[name];
    if (!g) throw new Error(`game not registered: ${name}`);
    const base = new ethers.Contract(g.module, abi, this.provider || this._requireSigner());
    return write ? base.connect(this._requireSigner()) : base;
  }

  _requireSigner() {
    if (!this.signer) throw new Error("wallet not connected");
    return this.signer;
  }

  _vaultW() { return this.vault.connect(this._requireSigner()); }

  // ── wallet plumbing (same surface the v14 SDK exposed) ──────────────────

  /** Native STT balance. Used by the slot pages for the "your balance" chip. */
  async getNativeBalance(addr = this.address) {
    const p = this.provider || this.signer?.provider;
    if (!p || !addr) return 0n;
    return await p.getBalance(addr);
  }

  /** MetaMask path (admin page + devWallet=metamask). Privy sets provider/
   *  signer directly and calls _rebuildContracts instead. */
  async connect() {
    if (!window.ethereum) throw new Error("No injected wallet (install MetaMask)");
    await this.switchToSomnia();
    this.provider = new ethers.BrowserProvider(window.ethereum);
    this.signer = await this.provider.getSigner();
    this.address = await this.signer.getAddress();
    this._rebuildContracts();
    return this.address;
  }

  async switchToSomnia() {
    const target = this.network.chainIdHex;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target }] });
    } catch (e) {
      if (e.code === 4902 || e?.error?.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: target,
            chainName: this.network.chainName,
            nativeCurrency: this.network.nativeCurrency,
            rpcUrls: this.network.rpcUrls,
            blockExplorerUrls: this.network.blockExplorerUrls,
          }],
        });
      } else { throw e; }
    }
  }

  /** v14 speculatively pre-signed the next spin to hide the Privy signing
   *  latency. Not implemented in v15 yet — a no-op keeps the call sites working
   *  (they treat it as best-effort) and simply pays the normal sign cost. */
  async presignClusterSpin() { return null; }

  randomClientSeed() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return ethers.hexlify(b);
  }

  // ── single-shot games (through the Vault) ───────────────────────────────

  /**
   * Dice. `target` is a PERCENT and may carry hundredths (0.01 .. 99.99), so a
   * player can chase a 0.01% roll at 9900x. It is sent on the module's
   * basis-point shape, which is 96 bytes and versioned — the old 64-byte
   * whole-percent shape still settles, but the two must never be confused
   * (`50` means 50% there and 0.50% here).
   */
  async placeDice(target, over, valueStr) {
    const bps = Math.round(Number(target) * 100);
    if (!Number.isFinite(bps) || bps < 1 || bps > 9999) {
      throw new Error(`dice target out of range: ${target} (0.01 .. 99.99)`);
    }
    const params = ethers.AbiCoder.defaultAbiCoder()
      .encode(["uint32", "bool", "uint8"], [bps, over, 1]);
    return this._placeSingle(GAME.DICE, params, valueStr);
  }

  /** Win chance in percent for a dice target, matching the module exactly. */
  static diceWinChance(target, over) {
    const bps = Math.round(Number(target) * 100);
    const winCount = over ? 10000 - bps : bps - 1;
    return winCount > 0 ? winCount / 100 : 0;
  }

  async placePlinko(risk, valueStr) {
    const params = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [risk]);
    return this._placeSingle(GAME.PLINKO, params, valueStr);
  }

  async _placeSingle(gameId, params, valueStr) {
    this._noteActivity();
    const clientSeed = this.randomClientSeed();
    const tx = await this._vaultW().placeBet(gameId, clientSeed, params, {
      value: ethers.parseEther(String(valueStr)),
    });
    const r = await this._betIdFrom(tx);
    return { ...r, clientSeed };
  }

  /** Pull the betId out of the BetPlaced log of our own tx. Returns the same
   *  shape the v14 SDK did ({betId, txHash, clientSeed}) so game pages that
   *  were written against v14 keep working unchanged. */
  async _betIdFrom(tx) {
    const rc = await tx.wait();
    for (const lg of rc.logs) {
      try {
        const p = this.vault.interface.parseLog({ topics: lg.topics, data: lg.data });
        if (p?.name === "BetPlaced") return { betId: Number(p.args.betId), txHash: tx.hash, tx, receipt: rc };
      } catch (_) {}
    }
    return { betId: null, txHash: tx.hash, tx, receipt: rc };
  }

  /// Pull an id out of OUR OWN transaction's logs.
  ///
  /// Module bet ids are handed out sequentially, so reading the module's global
  /// counter after tx.wait() returns whoever placed LAST — with two players on
  /// one slot that is somebody else's spin, and the page then waits on (and
  /// renders) a stranger's result. Reading our own log is exact; the counter
  /// stays only as a fallback for a receipt we somehow cannot parse.
  async _placedId(rc, mod, eventName, countFn) {
    const addr = String(mod.target || "").toLowerCase();
    for (const lg of rc.logs) {
      if (String(lg.address).toLowerCase() !== addr) continue;
      try {
        const p = mod.interface.parseLog({ topics: lg.topics, data: lg.data });
        if (p?.name === eventName) return Number(p.args.betId);
      } catch (_) {}
    }
    console.warn(`[SDK] ${eventName} log not found in our receipt — falling back to the global counter`);
    return Number(await countFn()) - 1;
  }

  // ── slots ───────────────────────────────────────────────────────────────

  async placeSlots(valueStr, useFreeSpin = false) { return this._spin("vault7", valueStr, useFreeSpin); }
  async placeCluster(valueStr, useFreeSpin = false) { return this._spin("cluster", valueStr, useFreeSpin); }

  async _spin(name, valueStr, useFreeSpin) {
    this._noteActivity();
    const clientSeed = this.randomClientSeed();
    const mod = this._mod(name, SLOT_ABI, true);
    const tx = await mod.placeSpin(clientSeed, useFreeSpin, {
      value: useFreeSpin ? 0n : ethers.parseEther(String(valueStr)),
    });
    const rc = await tx.wait();
    const betId = await this._placedId(rc, mod, "SpinPlaced", () => this._mod(name, SLOT_ABI).totalSpins());
    // Namespaced key ONLY: a bare id is ambiguous (vault7 spin 5, cluster spin 5
    // and dice bet 5 are three different bets), and storing it made a later
    // waitForSettle(5) for a Vault bet get routed into a slot module.
    this._spinIndex.set(name + ":" + betId, name);
    return { betId, txHash: tx.hash, clientSeed, tx, receipt: rc };
  }

  async buyBonusVault7(valueStr) { return this._buyBonus("vault7", valueStr); }
  async buyBonusCluster(valueStr) { return this._buyBonus("cluster", valueStr); }

  async _buyBonus(name, valueStr) {
    this._noteActivity();
    const mod = this._mod(name, SLOT_ABI, true);
    const clientSeed = this.randomClientSeed();
    const tx = await mod.buyBonus(clientSeed, { value: ethers.parseEther(String(valueStr)) });
    const rc = await tx.wait();
    const betId = await this._placedId(rc, mod, "SpinPlaced", () => this._mod(name, SLOT_ABI).totalSpins());
    this._spinIndex.set(name + ":" + betId, name);
    return { betId, txHash: tx.hash, clientSeed, tx, receipt: rc };
  }

  getSpin(name, betId) { return this._mod(name, SLOT_ABI).getSpin(betId); }
  /** Read-only slot module — used by slot-decoders to sync the live pay boost. */
  slotModule(name) { return this._mod(name, SLOT_ABI); }

  /** SUGAR.LAB module with the Charge Meter surface (reads + event decoding). */
  clusterModule() { return this._mod("cluster", [...SLOT_ABI, ...CLUSTER_EXTRA_ABI]); }
  freeSpinsAvailable(addr = this.address) { return this.loyalty ? this.loyalty.available(addr) : Promise.resolve(0n); }
  slotState(addr = this.address) { return this.loyalty?.getPlayerSlotState(addr); }

  async claimChargeReward() {
    const mod = this._mod("cluster", [...SLOT_ABI, ...CLUSTER_EXTRA_ABI], true);
    return (await mod.claimChargeReward()).wait();
  }
  getChargeMeter(addr = this.address) {
    return this._mod("cluster", [...SLOT_ABI, ...CLUSTER_EXTRA_ABI]).getChargeMeter(addr);
  }

  // ── mines ───────────────────────────────────────────────────────────────

  async placeMines(mineCount, valueStr) {
    const mod = this._mod("mines", MINES_ABI, true);
    this._noteActivity();
    const clientSeed = this.randomClientSeed();
    const tx = await mod.placeMinesBet(mineCount, clientSeed, {
      value: ethers.parseEther(String(valueStr)),
    });
    const rc = await tx.wait();
    const betId = await this._placedId(rc, mod, "MinesPlaced", () => this._mod("mines", MINES_ABI).totalGames());
    return { betId, txHash: tx.hash, clientSeed, tx, receipt: rc };
  }

  async pickMines(betId, cellIdx) { return (await this._mod("mines", MINES_ABI, true).pickCell(betId, cellIdx)).wait(); }
  async cancelMinesPick(betId)    { return (await this._mod("mines", MINES_ABI, true).cancelPick(betId)).wait(); }
  async cashoutMines(betId)       { return (await this._mod("mines", MINES_ABI, true).cashout(betId)).wait(); }
  getMinesGame(betId)             { return this._mod("mines", MINES_ABI).getGame(betId); }

  /** Resolves once the coordinator has committed the layout root. */
  async waitForMinesRoot(betId, timeoutMs = 30_000) {
    const mod = this._mod("mines", MINES_ABI);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const g = await mod.getGame(betId);
      if (g.layoutRoot !== ethers.ZeroHash) return g;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("timed out waiting for the mines layout root");
  }

  /** Resolves once a pending pick has been answered by the coordinator. */
  async waitForMinesPick(betId, timeoutMs = 30_000) {
    const mod = this._mod("mines", MINES_ABI);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const g = await mod.getGame(betId);
      if (Number(g.pendingCell) === 0) return g;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("timed out waiting for the pick to resolve");
  }

  // ── round games ─────────────────────────────────────────────────────────

  crash()    { return this._mod("crash", CRASH_ABI); }
  roulette() { return this._mod("roulette", ROULETTE_ABI); }

  /** Open a round on demand when none is live (keeps the house off idle gas). */
  async ensureRound(name) {
    const abi = name === "crash" ? CRASH_ABI : ROULETTE_ABI;
    const ro = this._mod(name, abi);
    if (await ro.hasOpenRound()) return false;
    await (await this._mod(name, abi, true).startRound()).wait();
    return true;
  }

  async placeCrash(autoCashoutX, valueStr) {
    this._noteActivity();
    await this.ensureRound("crash");
    const tx = await this._mod("crash", CRASH_ABI, true).placeBet(
      Math.round(Number(autoCashoutX) * 100),
      { value: ethers.parseEther(String(valueStr)) }
    );
    return tx.wait();
  }

  async requestCrashCashout(multX) {
    const tx = await this._mod("crash", CRASH_ABI, true).requestCashout(Math.round(Number(multX) * 100));
    return tx.wait();
  }

  /** bets: [{kind, number, amount}] where amount is a decimal string. */
  async placeRoulette(bets) {
    this._noteActivity();
    await this.ensureRound("roulette");
    const encoded = bets.map((b, i) => {
      // Accept the legacy `amountSTT` spelling too, but never hand ethers an
      // undefined: parseEther(String(undefined)) throws "invalid FixedNumber
      // string value", which names neither the bet nor the field and reads
      // like an RPC fault.
      const amt = b.amount ?? b.amountSTT;
      if (amt === undefined || amt === null || amt === "") {
        throw new Error(`roulette bet #${i + 1} has no amount`);
      }
      return { kind: b.kind, number: b.number || 0, amount: ethers.parseEther(String(amt)) };
    });
    const total = encoded.reduce((a, b) => a + b.amount, 0n);
    const tx = await this._mod("roulette", ROULETTE_ABI, true).placeBets(encoded, { value: total });
    return tx.wait();
  }

  // ── money + history (always the Vault) ──────────────────────────────────

  getPendingWithdrawal(addr = this.address) { return this.vault.pendingWithdrawals(addr); }
  async claim() { return (await this._vaultW().claim()).wait(); }

  /// Sweep winnings to the player's wallet — but NOT after every single spin.
  ///
  /// A claim is a transaction from the PLAYER's wallet, so it takes a nonce and
  /// a Privy signature (~0.4-1.4s) from the same lane the next spin needs. Firing
  /// one per spin would queue behind rapid spinning and burn gas on 0.004 STT
  /// wins. So this only *schedules*: every new bet pushes the timer out, and the
  /// sweep runs once the player has been idle for AUTO_CLAIM_IDLE_MS.
  /// Returns a PROMISE (every call site does `SL.autoClaim().catch(...)`, and
  /// returning undefined threw `Cannot read properties of undefined` right
  /// after each settle). It resolves with the swept amount when the sweep runs,
  /// or with 0n if a newer bet supersedes this one first.
  autoClaim(idleMs = 4000) {
    if (typeof window === "undefined") return Promise.resolve(0n);
    if (this._claimResolve) { this._claimResolve(0n); this._claimResolve = null; }
    clearTimeout(this._claimTimer);
    return new Promise((resolve) => {
      this._claimResolve = resolve;
      this._claimTimer = setTimeout(() => {
        this._claimResolve = null;
        resolve(this._claimNow());
      }, idleMs);
    });
  }

  /// Any placement postpones a pending sweep so it never races the next bet.
  /// Only reschedules when one is actually armed — `_claimTimer` is left set
  /// after it fires, so testing it alone would re-arm a sweep forever.
  _noteActivity() {
    if (this._claimResolve) this.autoClaim();
  }

  async _claimNow() {
    if (this._claiming) return 0n;
    this._claiming = true;
    try {
      if (!this.signer || !this.address) return 0n;
      const owed = await this.vault.pendingWithdrawals(this.address);
      if (owed === 0n) return 0n;
      await (await this._vaultW().claim()).wait();
      return owed;
    } catch (e) {
      console.warn("[SDK] autoClaim skipped:", e.shortMessage || e.message);
      return 0n;
    } finally { this._claiming = false; }
  }

  /// Immediate sweep, for an explicit "Claim" button.
  async claimNow() { return this._claimNow(); }

  freeBankroll() { return this.vault.freeBankroll(); }
  getBet(betId) { return this.vault.getBet(betId); }
  getPlayerBets(addr = this.address) { return this.vault.getPlayerBets(addr); }

  /** Max stake the risk policy currently allows for a game. */
  async maxBetFor(gameId) {
    const [free, bps, cap] = await Promise.all([
      this.vault.freeBankroll(), this.vault.maxBetBps(), this.vault.gameMaxBet(gameId),
    ]);
    const byBps = (free * bps) / 10000n;
    if (cap === 0n) return byBps;
    return byBps < cap ? byBps : cap;
  }

  /** Poll until settled. Routes to the owning slot module when this id was
   *  placed as a spin (module ids are local, so the Vault would report
   *  BetNotFound for them). Returns the SETTLED EVENT, matching v14, because
   *  pages read `settled.args.resultData` to render the reels. */
  async waitForSettle(betId, timeoutMs = 60_000) {
    const game = this._spinIndex.get(String(betId));
    if (game) return this.waitForSpinSettle(game, betId, timeoutMs);
    return this._waitForVaultSettle(betId, timeoutMs);
  }

  async _waitForVaultSettle(betId, timeoutMs = 60_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const b = await this.vault.getBet(betId);
      if (Number(b.status) !== 0) {
        let ev = null;
        try {
          const logs = await this.vault.queryFilter(this.vault.filters.BetSettled(betId), -900);
          ev = logs.length ? logs[logs.length - 1] : null;
        } catch (_) {}
        return this._flatSettled({
          id: betId, player: b.player, game: Number(b.gameId),
          won: ev?.args?.won ?? b.won, payout: ev?.args?.payout ?? b.payout,
          randomness: ev?.args?.randomness ?? b.randomness,
          serverSeed: ev?.args?.serverSeed ?? ethers.ZeroHash,
          clientSeed: b.clientSeed, blockHash: ev?.args?.blockHash ?? ethers.ZeroHash,
          nonce: b.nonce, resultData: ev?.args?.resultData ?? "0x",
          txHash: ev?.transactionHash, status: Number(b.status),
          refunded: Number(b.status) === 2,
        });
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    throw new Error("timed out waiting for settlement");
  }

  /// v14 handed pages a FLAT settle object (settled.payout / .randomness /
  /// .resultData). Decoders read those directly, so v15 must match exactly.
  /// `args` is attached as a self-reference for the few call sites that read
  /// settled.args.* instead.
  _flatSettled(o) {
    o.args = o;
    return o;
  }


  /** Poll a slot spin until settled and return its SpinSettled event, shaped
   *  like the v14 BetSettled result the pages expect (args.* plus the spin's
   *  clientSeed/nonce, which the event itself does not carry). */
  async waitForSpinSettle(name, betId, timeoutMs = 60_000) {
    const mod = this._mod(name, SLOT_ABI);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const sp = await mod.getSpin(betId);
      if (Number(sp.status) !== 0) {
        let ev = null;
        try {
          // Somnia caps eth_getLogs at 1000 blocks.
          const logs = await mod.queryFilter(mod.filters.SpinSettled(betId), -900);
          ev = logs.length ? logs[logs.length - 1] : null;
        } catch (_) {}
        return this._flatSettled({
          id: betId, player: sp.player,
          game: name === "cluster" ? GAME.CLUSTER : GAME.SLOTS,
          won: ev?.args?.won ?? sp.payout > 0n,
          payout: ev?.args?.payout ?? sp.payout,
          randomness: ev?.args?.randomness ?? sp.randomness,
          serverSeed: ev?.args?.serverSeed ?? ethers.ZeroHash,
          clientSeed: sp.clientSeed, blockHash: ethers.ZeroHash, nonce: sp.nonce,
          resultData: ev?.args?.resultData ?? "0x",
          txHash: ev?.transactionHash, status: Number(sp.status),
          refunded: Number(sp.status) === 2, freeSpin: sp.freeSpin, spin: sp,
        });
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    throw new Error("timed out waiting for the spin to settle");
  }


  /** Games currently live, straight from the registry — a game added later
   *  shows up here with no SDK change. */
  async liveGames() {
    const out = [];
    for (const g of this.manifest.games) {
      if (await this.vault.gameActive(g.id)) out.push(g);
    }
    return out;
  }

  subscribeBetSettled(cb) {
    const h = (...a) => cb(a[a.length - 1]);
    this.vault.on("BetSettled", h);
    return () => this.vault.off("BetSettled", h);
  }
}

export default ShinyLuckV15;
