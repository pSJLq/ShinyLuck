// ShinyLuck frontend SDK - vanilla JS / ESM, wraps ethers v6.
//
// Usage:
//   import { ShinyLuck, GAME, CHAINS } from "./lib/shinyluck-sdk.js";
//   const sl = new ShinyLuck({
//     casino: "0x...",
//     registry: "0x...",
//     network: CHAINS.somniaTestnet
//   });
//   await sl.connect();
//   const { betId, txHash } = await sl.placeDice(50, true, "0.1");
//   const settled = await sl.waitForSettle(betId);

import { ethers } from "/vendor/ethers.bundle.js";

export const CHAINS = {
  somniaTestnet: {
    chainIdHex: "0xc488", // 50312
    chainId: 50312,
    chainName: "Somnia Testnet (Shannon)",
    nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
    // Canonical Somnia infra endpoints (matches emrestay's reactivity
    // examples + somnia-devrel SKILL.md). `dream-rpc.somnia.network` is
    // the public RPC - works for tx submission but WS subs there
    // occasionally drop silently. `api.infra.testnet.somnia.network` is
    // the validator infra endpoint maintained by the Somnia team, used
    // by every first-party example. Order matters - list canonical
    // first, public second as fallback.
    rpcUrls: ["https://api.infra.testnet.somnia.network", "https://dream-rpc.somnia.network"],
    wsUrls: ["wss://api.infra.testnet.somnia.network/ws", "wss://dream-rpc.somnia.network/ws"],
    blockExplorerUrls: ["https://shannon-explorer.somnia.network"],
  },
  somniaMainnet: {
    chainIdHex: "0x13a7", // 5031
    chainId: 5031,
    chainName: "Somnia",
    nativeCurrency: { name: "SOMI", symbol: "SOMI", decimals: 18 },
    rpcUrls: ["https://api.infra.mainnet.somnia.network/"],
    wsUrls: ["wss://api.infra.mainnet.somnia.network/ws"],
    blockExplorerUrls: ["https://explorer.somnia.network"],
  },
};

export const GAME = { DICE: 0, CRASH: 1, SLOTS: 2, MINES: 3, PLINKO: 4, ROULETTE: 5, CLUSTER: 6 };

export const ROULETTE = {
  STRAIGHT: 0, RED: 1, BLACK: 2, EVEN: 3, ODD: 4,
  LOW: 5, HIGH: 6, DOZEN_1: 7, DOZEN_2: 8, DOZEN_3: 9,
};

// Trimmed ABIs - enough to drive the frontend. For a full ABI, fetch from
// hardhat artifacts at build time.
const CASINO_ABI = [
  // per-bet games
  "function placeDiceBet(uint8 target, bool over, bytes32 clientSeed) payable returns (uint256)",
  "function placeSlotsBet(bytes32 clientSeed,bool useFreeSpin) payable returns (uint256)",
  "function placeClusterBet(bytes32 clientSeed,bool useFreeSpin) payable returns (uint256)",
  "function buyBonusCluster(bytes32 clientSeed) payable returns (uint256)",
  "function buyBonusVault7(bytes32 clientSeed) payable returns (uint256)",
  "function claimChargeReward() external",
  "function getChargeMeter(address) view returns (uint256 current, uint256 threshold, uint256 pendingReward, uint8 cycle)",
  // Live RTP display. Missing from this ABI for a while - both slot pages
  // call SL.casino.getReportedRTP() in their refreshRtp(), which threw
  // "not a function" into a silent catch: VAULT.7 was rescued by
  // livedata.js (its own ABI has the method and its selector matches that
  // page), SUGAR.LAB just showed the baked-in 92% placeholder forever.
  "function getReportedRTP(uint8) view returns (uint16)",
  "event RtpAdjusted(uint8 indexed game, uint16 oldRtpBps, uint16 newRtpBps, string reasoning)",
  "event BuyBonusPlaced(uint256 indexed betId, address indexed player, uint8 game, uint256 totalStake, uint256 unitStake)",
  "event ChargeMeterBumped(address indexed player, uint256 newCharge, uint256 threshold)",
  "event ChargeMeterTriggered(address indexed player, uint8 rewardId, uint256 amount, uint8 cycle)",
  "function freeSpinsAvailable(address) view returns (uint256)",
  "function getPlayerSlotState(address) view returns (uint64,uint64,uint64,uint256)",
  "event FreeSpinsEarned(address indexed player,uint64 totalSpins,uint64 freeSpinsEarned)",
  "event FreeSpinConsumed(address indexed player,uint256 indexed betId,uint8 game)",
  "function placeMinesBet(uint8 mineCount, bytes32 clientSeed) payable returns (uint256)",
  "function placeplinkoBet(uint8 risk, bytes32 clientSeed) payable returns (uint256)",
  "function revealAndSettle(uint256 betId, bytes32 serverSeed) external",
  "function revealMinesSeed(uint256 betId, bytes32 serverSeed) external",
  "function openMinesCell(uint256 betId, uint8 cellIdx) external",
  "function cashoutMines(uint256 betId) external",
  "function refundExpired(uint256 betId) external",
  // round-based Crash
  "function startCrashRound() external",
  "function placeCrashBet(uint256 autoCashoutX100) payable",
  "function requestCashout(uint256 multX100) external",
  "function settleCrashRound(uint256 roundId, bytes32 serverSeed) external",
  "function refundCrashRound(uint256 roundId) external",
  "function totalCrashRounds() view returns (uint256)",
  "function currentCrashRoundId() view returns (uint256)",
  "function getCrashRound(uint256) view returns (uint64 id,uint64 betWindowEnd,uint64 commitBlock,uint32 seedIdx,bool settled,uint16 crashPointX100,bytes32 serverSeed,uint256 bettorCount)",
  "function getCrashBettors(uint256) view returns (address[])",
  "function getCrashBet(uint256,address) view returns (tuple(uint96 amount,uint16 autoCashoutX100,uint16 cashoutMultX100,bool resolved))",
  // round-based Roulette
  "function startRouletteRound() external",
  "function placeRouletteBets(tuple(uint8 kind,uint8 number,uint96 amount)[]) payable",
  "function settleRouletteRound(uint256 roundId, bytes32 serverSeed) external",
  "function refundRouletteRound(uint256 roundId) external",
  "function totalRouletteRounds() view returns (uint256)",
  "function currentRouletteRoundId() view returns (uint256)",
  "function getRouletteRound(uint256) view returns (uint64 id,uint64 betWindowEnd,uint64 commitBlock,uint32 seedIdx,bool settled,uint8 resultNumber,bytes32 serverSeed,uint256 bettorCount)",
  "function getRouletteBettors(uint256) view returns (address[])",
  "function getRouletteBets(uint256,address) view returns (tuple(uint8 kind,uint8 number,uint96 amount)[])",
  // claims & reads
  "function claim() external",
  "function depositBankroll() payable",
  "function pendingWithdrawals(address) view returns (uint256)",
  "function freeBankroll() view returns (uint256)",
  "function gameMaxBet(uint8) view returns (uint256)",
  "function gamePaused(uint8) view returns (bool)",
  "function totalBets() view returns (uint256)",
  "function getBet(uint256) view returns (tuple(address player,uint96 amount,uint8 game,uint8 status,uint64 commitBlock,uint64 nonce,uint256 seedIdx,bytes32 clientSeed,bytes params,bytes32 randomness,uint128 payout,bool won))",
  "function getPlayerBets(address) view returns (uint256[])",
  "function getSlotsTheme() view returns (string,string[5],uint256)",
  "function bonusModeActive() view returns (bool)",
  "function bonusModeUntil() view returns (uint256)",
  "function houseEdgeBps(uint8) view returns (uint256)",
  "function seedPoolStatus() view returns (uint256,uint256,uint256)",
  "function minesState(uint256) view returns (uint8 mineCount,uint32 openedBitmap,uint32 minesBitmap,bool seedRevealed,bool busted)",
  // events - per-bet
  "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
  "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
  "event BetRefunded(uint256 indexed betId,address indexed player,uint256 amount,string reason)",
  "event WithdrawalCredited(address indexed player,uint256 amount)",
  "event WithdrawalClaimed(address indexed player,uint256 amount)",
  "event BankrollDeposited(address indexed from,uint256 amount)",
  // events - round-based
  "event CrashRoundStarted(uint256 indexed roundId,uint256 betWindowEnd,uint256 commitBlock,uint256 seedIdx)",
  "event CrashBetPlaced(uint256 indexed roundId,address indexed player,uint256 amount,uint256 autoCashoutX100)",
  "event CrashCashoutRequested(uint256 indexed roundId,address indexed player,uint256 multX100)",
  "event CrashRoundSettled(uint256 indexed roundId,uint256 crashPointX100,bytes32 serverSeed,bytes32 randomness,bytes32 blockHash)",
  "event CrashRoundRefunded(uint256 indexed roundId,string reason)",
  "event RouletteRoundStarted(uint256 indexed roundId,uint256 betWindowEnd,uint256 commitBlock,uint256 seedIdx)",
  "event RouletteBetPlaced(uint256 indexed roundId,address indexed player,uint8 kind,uint8 number,uint256 amount)",
  "event RouletteRoundSettled(uint256 indexed roundId,uint8 resultNumber,bytes32 serverSeed,bytes32 randomness)",
  "event RouletteRoundRefunded(uint256 indexed roundId,string reason)",
  // HM events
  "event BonusModeActivated(uint256 until,string reasoning)",
  "event ReasoningLog(string thought,uint256 timestamp)",
  "event SlotsThemeChanged(string name,string[5] symbols,uint256 timestamp)",
  "event GameMaxBetSet(uint8 indexed game,uint256 amount)",
  "event GamePaused(uint8 indexed game,bool paused)",
  // Custom errors - ethers decodes revert data into readable names when the
  // error signatures are part of the contract ABI.
  "error NotHouseManager()",
  "error GameIsPaused()",
  "error InvalidGame()",
  "error InvalidBet(string reason)",
  "error NoSeedAvailable()",
  "error BetNotFound()",
  "error BetAlreadySettled()",
  "error BankrollInsufficient()",
  "error BetTooLarge()",
  "error RevealTooEarly(uint256 currentBlock, uint256 earliestBlock)",
  "error RevealExpired(uint256 currentBlock, uint256 latestBlock)",
  "error InvalidServerSeed()",
  "error RoundNotFound()",
  "error RoundClosed()",
  "error RoundNotSettleable()",
  "error RoundAlreadySettled()",
  "error CashoutTooLow()",
  "error TooManyBets()",
];

const REGISTRY_ABI = [
  // gen-14: the natural-language strategy is now stored on-chain (verbatim) so
  // HouseManager injects it into the per-player LLM prompt. strategyHash is
  // still derived on-chain (keccak256 of the string) as an integrity commitment.
  "function registerAgent(string strategy,uint256 dailyLimit,uint256 totalLimit,uint8 allowedGamesMask) payable returns (address)",
  "function pauseAgent() external",
  "function resumeAgent() external",
  "function updateAgentParams(uint256 dailyLimit,uint256 totalLimit,uint8 allowedGamesMask,string strategy) external",
  "function getStrategy(address) view returns (string)",
  "function getPermission(address) view returns (tuple(address player,address vault,bytes32 strategyHash,uint256 dailyLimit,uint256 totalLimit,uint8 allowedGamesMask,bool active,uint256 spentToday,uint256 spentTotal,uint64 lastResetDay))",
  "event AgentRegistered(address indexed player,address indexed vault,bytes32 strategyHash,uint256 dailyLimit,uint256 totalLimit,uint8 allowedGamesMask)",
];

export class ShinyLuck {
  constructor({ casino, registry, network = CHAINS.somniaTestnet }) {
    this.casinoAddress = casino;
    this.registryAddress = registry;
    this.network = network;
    this.provider = null;
    this.signer = null;
    this.casino = null;
    this.registry = null;
    this.address = null;
    // Pre-sign slot: holds the signed-but-not-broadcasted next-spin tx,
    // so user's next click skips the ~700-1000ms Privy iframe sign step.
    // See `_presign` / `_tryPresignedBroadcast` below.
    this._presigned = null;
  }

  async connect() {
    if (!window.ethereum) throw new Error("No injected wallet (install MetaMask)");
    await this.switchToSomnia();
    this.provider = new ethers.BrowserProvider(window.ethereum);
    this.signer = await this.provider.getSigner();
    this.address = await this.signer.getAddress();
    this._rebuildContracts();
    return this.address;
  }

  /// Rebuild Casino + Registry contract instances bound to the current signer.
  /// Called by wallet.js after Sequence sign-in too - same ABI, different
  /// signer backend.
  _rebuildContracts() {
    if (!this.signer) throw new Error("ShinyLuck: signer not set");
    this.casino = new ethers.Contract(this.casinoAddress, CASINO_ABI, this.signer);
    if (this.registryAddress) {
      this.registry = new ethers.Contract(this.registryAddress, REGISTRY_ABI, this.signer);
    }
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

  randomClientSeed() {
    return ethers.hexlify(ethers.randomBytes(32));
  }

  // -------------------------------------------------------------------
  // Pre-sign cache - speculatively signs the next spin during the cascade
  // animation of the current one, so the user's next click only needs the
  // broadcast round-trip (~150-200ms) instead of paying the Privy iframe
  // sign latency (~500-800ms) on the critical path.
  //
  // Caller flow:
  //   onSpinCompleted: SL.presignClusterSpin(stakeStr)
  //   onSpinRequest:   SL.placeCluster(stakeStr)  // consumes presign if matching
  //
  // Safety:
  //   - presign is invalidated if stake changes between presign and click
  //   - presign expires after 25s (fee data refresh window)
  //   - any broadcast error invalidates the presign + falls back to fresh sign
  // -------------------------------------------------------------------

  async presignClusterSpin(stakeStr) {
    // Track in-flight promise so _tryPresignedBroadcast can await it
    // (avoids the nonce-gap race: user clicked before presign's iframe
    // sign finished → presign reserved nonce N, live tx took N+1, mempool
    // sat waiting for N forever).
    this._presignInFlight = this._presign("cluster", stakeStr, false)
      .finally(() => { this._presignInFlight = null; });
    return this._presignInFlight;
  }

  async _presign(game, stakeStr, useFreeSpin) {
    const t0 = performance.now();
    let reservedNonce = null;
    try {
      if (!this.signer) { console.warn("[presign] no signer"); return null; }
      if (typeof window.ShinyLuckAuth?.signTransaction !== "function") {
        console.warn("[presign] ShinyLuckAuth.signTransaction missing");
        return null;
      }
      if (typeof this.signer._populateFor !== "function") {
        console.warn("[presign] signer._populateFor missing (signer:", this.signer?.constructor?.name, ")");
        return null;
      }
      const value = useFreeSpin ? 0n : ethers.parseEther(String(stakeStr));
      const cs = this.randomClientSeed();
      let data;
      if (game === "cluster") data = this.casino.interface.encodeFunctionData("placeClusterBet", [cs, useFreeSpin]);
      else if (game === "slots") data = this.casino.interface.encodeFunctionData("placeSlotsBet", [cs, useFreeSpin]);
      else return null;
      const txReq = { to: this.casino.target, value, data };
      const populated = await this.signer._populateFor(txReq);
      reservedNonce = populated.nonce;
      const signedRaw = await window.ShinyLuckAuth.signTransaction({
        to: txReq.to, value, data,
        chainId: this.network.chainId,
        nonce: populated.nonce,
        gas: populated.gas,
        maxFeePerGas: populated.maxFeePerGas,
        maxPriorityFeePerGas: populated.maxPriorityFeePerGas,
      });
      this._presigned = {
        game, value, clientSeed: cs, signedRaw,
        populatedTx: populated, signedAt: Date.now(),
      };
      const dt = (performance.now() - t0).toFixed(0);
      console.log(`[presign] ready in ${dt}ms (game=${game}, value=${value}, nonce=${populated.nonce})`);
      return true;
    } catch (e) {
      console.warn("[presign] failed:", e?.message || e);
      this._presigned = null;
      // If we reserved a nonce but failed to sign, force chain resync so
      // the next populate fetches the actual pending count (without our
      // dead reservation) - otherwise we'd open a gap.
      if (reservedNonce !== null && this.signer) this.signer._lastChainSyncAt = 0;
      return null;
    }
  }

  // Returns a {betId, txHash, clientSeed} promise via _raceForBetId, using
  // the pre-signed tx if it matches the requested game+stake and is fresh.
  // Otherwise returns null so the caller falls through to fresh-sign path.
  async _tryPresignedBroadcast(game, value) {
    // RACE-WAIT: a presign may be in flight when the user clicks. Its
    // `_populateFor` has already reserved a nonce; if we fall through
    // to fresh sign now, fresh sign reserves nonce+1 and the unbroadcast
    // presign opens a permanent gap in mempool → 18 s timeout. Wait up
    // to 600 ms for the presign to finish, then either use it (HIT) or
    // skip it through the regular drop-and-resync path (chain sync gets
    // reset, fresh sign re-fetches the correct next nonce).
    if (this._presignInFlight && !this._presigned) {
      try {
        await Promise.race([
          this._presignInFlight,
          new Promise((r) => setTimeout(r, 600)),
        ]);
      } catch (_) {}
    }
    const ps = this._presigned;
    if (!ps) {
      // No presigned tx materialised within the wait window. But the
      // in-flight presign might STILL complete shortly and reserve its
      // nonce → gap. Pre-emptively invalidate chain sync so the next
      // populate (live sign) re-reads chain pending count.
      if (this._presignInFlight && this.signer) this.signer._lastChainSyncAt = 0;
      return null;
    }
    // When the presigned tx CAN'T be used (game/value mismatch / stale),
    // we MUST clear it AND force a chain-nonce resync. The presign
    // reserved a nonce that will never be broadcast - without resync the
    // next fresh sign would pick reserved+1 and open a permanent gap in
    // the mempool. Chain queues reserved+1 forever, _raceForBetId hits
    // its 18 s deadline. That's the timeout bug we kept chasing.
    const dropAndResync = (reason) => {
      console.log(`[presign] skip: ${reason}`);
      this._presigned = null;
      if (this.signer) this.signer._lastChainSyncAt = 0;
      return null;
    };
    if (ps.game !== game) return dropAndResync(`game mismatch ${ps.game} vs ${game}`);
    if (ps.value !== value) return dropAndResync(`value mismatch ${ps.value} vs ${value}`);
    if (Date.now() - ps.signedAt > 25_000) return dropAndResync("stale");
    // Nonce-staleness check: presigned tx is valid only if its nonce
    // matches the CURRENT pending count on chain. If something else
    // submitted a tx in between (live click while presign was in flight,
    // tx in another tab, etc.), our nonce is too low → would fail on
    // broadcast. Single live RPC check.
    try {
      const chainNonce = BigInt(
        await this.provider.send("eth_getTransactionCount", [this.address, "pending"])
      );
      if (ps.populatedTx.nonce < chainNonce) {
        console.log(`[presign] skip: nonce stale (presigned=${ps.populatedTx.nonce}, chain=${chainNonce})`);
        this._presigned = null;
        return null;
      }
    } catch (_) { /* if RPC chokes, try the broadcast anyway */ }
    this._presigned = null;
    console.log(`[presign] HIT - broadcasting (nonce=${ps.populatedTx.nonce})`);
    const txPromise = this.provider.broadcastTransaction(ps.signedRaw)
      .catch((e) => {
        // Force a chain-nonce resync on the next populate so we don't keep
        // a permanent gap from the failed broadcast.
        if (this.signer) this.signer._lastChainSyncAt = 0;
        throw e;
      });
    return await this._raceForBetId(txPromise, ps.clientSeed);
  }

  // Bet placement -------------------------------------------------------

  async placeDice(target, over, valueStr) {
    const cs = this.randomClientSeed();
    return await this._placeWithRace(this.casino.placeDiceBet, [target, over, cs], cs, ethers.parseEther(String(valueStr)));
  }

  /// @notice Round-based Crash. autoCashoutX is in plain multiplier units
  ///         (e.g. 2.5 = 2.5×). Pass 0 for manual-only.
  ///         The caller MUST place during an open bet window - query
  ///         currentCrashRoundId / getCrashRound for state. Returns the
  ///         {roundId, txHash} so the UI can correlate with the round.
  async placeCrash(autoCashoutX, valueStr) {
    const ac = Math.round(Math.max(0, autoCashoutX) * 100);
    const tx = await this.casino.placeCrashBet(ac, { value: ethers.parseEther(String(valueStr)) });
    const r = await tx.wait();
    const roundId = (await this.casino.currentCrashRoundId()).toString();
    return { roundId, txHash: tx.hash, blockNumber: r.blockNumber };
  }

  /// @notice Request a manual cashout during a running round.
  async requestCrashCashout(multX) {
    const m = Math.round(multX * 100);
    const tx = await this.casino.requestCashout(m);
    return await tx.wait();
  }

  /// VAULT.7 spin. Pass `useFreeSpin=true` (and valueStr=0) to redeem one of
  /// the player's earned loyalty free spins.
  async placeSlots(valueStr, useFreeSpin = false) {
    const cs = this.randomClientSeed();
    const value = useFreeSpin ? 0n : ethers.parseEther(String(valueStr));
    return await this._placeWithRace(this.casino.placeSlotsBet, [cs, useFreeSpin], cs, value);
  }

  /// SUGAR.LAB spin (7×7 cluster pays).
  async placeCluster(valueStr, useFreeSpin = false) {
    const value = useFreeSpin ? 0n : ethers.parseEther(String(valueStr));
    if (!useFreeSpin) {
      // _tryPresignedBroadcast is async now (does a chain-nonce check
      // before consuming). Returns null when no presign matches, or a
      // resolved {betId, txHash, clientSeed} when it broadcasts.
      const ps = await this._tryPresignedBroadcast("cluster", value);
      if (ps) return ps;
    }
    const cs = this.randomClientSeed();
    return await this._placeWithRace(this.casino.placeClusterBet, [cs, useFreeSpin], cs, value);
  }

  /// SUGAR.LAB Buy Bonus - pay 100× unitStake for a high-variance bonus spin.
  async buyBonusCluster(unitStakeStr) {
    const cs = this.randomClientSeed();
    const value = ethers.parseEther(String(unitStakeStr)) * 100n;
    return await this._placeWithRace(this.casino.buyBonusCluster, [cs], cs, value);
  }

  /// VAULT.7 Buy Bonus - pay 75× unitStake.
  async buyBonusVault7(unitStakeStr) {
    const cs = this.randomClientSeed();
    const value = ethers.parseEther(String(unitStakeStr)) * 75n;
    return await this._placeWithRace(this.casino.buyBonusVault7, [cs], cs, value);
  }

  /// Claim any pending Charge Meter reward into pendingWithdrawals.
  async claimChargeReward() {
    const tx = await this.casino.claimChargeReward();
    return await tx.wait();
  }

  async placeMines(mineCount, valueStr) {
    const cs = this.randomClientSeed();
    return await this._placeWithRace(this.casino.placeMinesBet, [mineCount, cs], cs, ethers.parseEther(String(valueStr)));
  }

  async placePlinko(risk, valueStr) {
    const cs = this.randomClientSeed();
    return await this._placeWithRace(this.casino.placeplinkoBet, [risk, cs], cs, ethers.parseEther(String(valueStr)));
  }

  /// @notice Round-based Roulette. `bets` is an array of {kind, number, amountSTT}.
  ///         `kind` is the RouletteBetKind enum (0..9). msg.value is the sum.
  async placeRoulette(bets) {
    if (!Array.isArray(bets) || bets.length === 0) throw new Error("at least one bet required");
    const tuples = bets.map((b) => ({
      kind: b.kind,
      number: b.number || 0,
      amount: ethers.parseEther(String(b.amountSTT)),
    }));
    const total = tuples.reduce((acc, t) => acc + t.amount, 0n);
    const tx = await this.casino.placeRouletteBets(tuples, { value: total });
    const r = await tx.wait();
    const roundId = (await this.casino.currentRouletteRoundId()).toString();
    return { roundId, txHash: tx.hash, blockNumber: r.blockNumber };
  }

  async _extractBetId(tx, clientSeed) {
    const r = await tx.wait();
    for (const log of r.logs) {
      try {
        const parsed = this.casino.interface.parseLog(log);
        if (parsed && parsed.name === "BetPlaced") {
          return { betId: parsed.args.betId, txHash: tx.hash, clientSeed };
        }
      } catch (_) {}
    }
    return { betId: null, txHash: tx.hash, clientSeed };
  }

  /// Race the contract call against a WS BetPlaced subscription. With
  /// Sequence WaaS, `await contractMethod()` blocks for ~20-25s on the
  /// relayer round-trip even after the tx is mined on chain. The WS event
  /// fires within ~1s of chain inclusion. Whichever arrives first wins -
  /// for Sequence users this drops placement-to-betId from 25s → ~3-5s.
  /// MetaMask flow is also slightly faster (skips ethers' receipt poll).
  ///
  /// If the WS path wins, the tx promise still resolves in the background
  /// (we don't unsubscribe early enough to lose it) - caller doesn't care
  /// because the chain has authoritative state via BetPlaced + BetSettled.
  async _placeWithRace(contractMethod, args, clientSeed, value) {
    const txPromise = contractMethod.apply(this.casino, [...args, value != null ? { value } : {}]);
    return await this._raceForBetId(txPromise, clientSeed);
  }

  async _raceForBetId(txPromise, clientSeed) {
    const wsMod = await import("./rpc.js");
    const ws = wsMod.wsProvider ? wsMod.wsProvider() : null;
    // `this.address` is set by wallet.js after a successful connect - it's
    // the EOA / smart-wallet address that emits BetPlaced as the indexed
    // player topic. Pad to 32 bytes for topic comparison.
    const playerAddr = this.address || (this.signer && (this.signer.address ||
      (typeof this.signer.getAddress === "function" ? await this.signer.getAddress().catch(() => null) : null)));

    return new Promise((resolve, reject) => {
      let done = false;
      let txHashOuter = null;
      const finish = (val, err) => {
        if (done) return;
        done = true;
        if (handler) {
          try { ws && ws.off({ address: this.casino.target, topics: [topic] }, handler); } catch (_) {}
        }
        if (err) reject(err); else resolve(val);
      };

      let handler = null, topic = null;
      if (ws && playerAddr) {
        try {
          topic = this.casino.interface.getEvent("BetPlaced").topicHash;
          const paddedAddr = "0x" + playerAddr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
          handler = (log) => {
            try {
              if ((log.topics[2] || "").toLowerCase() !== paddedAddr) return;
              const parsed = this.casino.interface.parseLog(log);
              finish({ betId: parsed.args.betId, txHash: txHashOuter || log.transactionHash, clientSeed });
            } catch (_) {}
          };
          ws.on({ address: this.casino.target, topics: [topic] }, handler);
        } catch (_) {}
      }

      // Tx promise: always resolves (slow path with Sequence). If it lands
      // before WS, parse the receipt; otherwise we ignore the result.
      txPromise.then(async (tx) => {
        txHashOuter = tx.hash;
        try {
          const r = await tx.wait();
          if (done) return;                      // WS already won
          for (const log of r.logs) {
            try {
              const parsed = this.casino.interface.parseLog(log);
              if (parsed && parsed.name === "BetPlaced") {
                finish({ betId: parsed.args.betId, txHash: tx.hash, clientSeed });
                return;
              }
            } catch (_) {}
          }
          finish({ betId: null, txHash: tx.hash, clientSeed });
        } catch (e) { finish(null, e); }
      }).catch((e) => finish(null, e));

      // Hard timeout - 90s to give Sequence a generous window.
      // 18 s outer deadline. PrivySigner's inner timeouts are 6 s sign
      // + 10 s legacy = 16 s sum, so 18 s outer gives the inner paths
      // a real chance to surface their own error first. If we hit 18 s
      // here, it means even after Privy's own race-fallback the tx
      // didn't get a hash - the caller (spin retry loop) should retry.
      setTimeout(() => finish(null, new Error("placement timed out")), 18_000);
    });
  }

  // Reveal -------------------------------------------------------------

  async waitForRevealable(betId) {
    const bet = await this.casino.getBet(betId);
    const targetBlock = Number(bet.commitBlock) + 4; // strict > commitBlock + 3
    while (true) {
      const cur = await this.provider.getBlockNumber();
      if (cur >= targetBlock) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /// @notice The serverSeed is delivered out-of-band by the house service.
  ///         Frontend polls /seeds/:idx to fetch when available, then submits.
  async revealAndSettle(betId, serverSeed) {
    const tx = await this.casino.revealAndSettle(betId, serverSeed);
    return await tx.wait();
  }

  /// @notice Wait for a BetSettled event matching betId.
  ///
  /// Race two subscriptions:
  ///   (a) WS push subscription (if Somnia gateway accepts upgrade) -
  ///       events arrive <200ms after the settle tx is mined.
  ///   (b) The default HTTP-poll-based contract event - falls back when
  ///       WS isn't available.
  /// Whichever fires first wins; we cancel the loser.
  ///
  /// This shaves ~800-1000ms off the end-of-spin latency that the default
  /// 1000ms ethers polling interval otherwise imposes on top of the
  /// 3-block reveal delay.
  async waitForSettle(betId, timeoutMs = 60_000) {
    const t0 = performance.now();
    const targetId = BigInt(betId);
    return new Promise(async (resolve, reject) => {
      let done = false;
      let cleanupWs = null;
      let cleanupHttp = null;
      const settle = (src, parsed) => {
        if (done) return;
        done = true;
        const dt = (performance.now() - t0).toFixed(0);
        console.log(`[SDK] waitForSettle resolved via ${src} in ${dt}ms (betId=${betId})`);
        cleanupWs?.(); cleanupHttp?.();
        clearTimeout(timer);
        resolve(parsed);
      };

      // (a) WS subscription via raw filter - bypasses ethers contract event
      // polling, pushes from the gateway.
      try {
        const { wsProvider } = await import("./rpc.js");
        const ws = wsProvider();
        if (ws) {
          const topic0 = this.casino.interface.getEvent("BetSettled").topicHash;
          const filter = { address: this.casino.target, topics: [topic0] };
          const onWsLog = (log) => {
            try {
              const p = this.casino.interface.parseLog({ topics: log.topics, data: log.data });
              if (BigInt(p.args.id ?? p.args.betId ?? p.args[0]) === targetId) {
                const a = p.args;
                settle("ws", {
                  id: a.id ?? a.betId, player: a.player, game: a.game, won: a.won,
                  payout: a.payout, randomness: a.randomness, serverSeed: a.serverSeed,
                  clientSeed: a.clientSeed, blockHash: a.blockHash, nonce: a.nonce,
                  resultData: a.resultData, txHash: log.transactionHash,
                });
              }
            } catch (_) {}
          };
          ws.on(filter, onWsLog);
          cleanupWs = () => { try { ws.off(filter, onWsLog); } catch (_) {} };
        }
      } catch (e) { console.warn("[SDK] ws subscribe failed, http only:", e.message); }

      // (b) HTTP-poll fallback (the original path)
      const httpHandler = (id, player, game, won, payout, randomness, serverSeed, clientSeed, blockHash, nonce, resultData, ev) => {
        if (BigInt(id) === targetId) {
          settle("http", { id, player, game, won, payout, randomness, serverSeed, clientSeed, blockHash, nonce, resultData, txHash: ev?.log?.transactionHash });
        }
      };
      this.casino.on("BetSettled", httpHandler);
      cleanupHttp = () => { try { this.casino.off("BetSettled", httpHandler); } catch (_) {} };

      const timer = setTimeout(() => {
        if (done) return; done = true;
        cleanupWs?.(); cleanupHttp?.();
        reject(new Error("settle timeout"));
      }, timeoutMs);
    });
  }

  // Reads --------------------------------------------------------------

  async getNativeBalance(addr = this.address) {
    return await this.provider.getBalance(addr);
  }

  async getPendingWithdrawal(addr = this.address) {
    return await this.casino.pendingWithdrawals(addr);
  }

  async claim() {
    const tx = await this.casino.claim();
    return await tx.wait();
  }

  async getRecentBets(addr = this.address, limit = 25) {
    const ids = await this.casino.getPlayerBets(addr);
    const slice = ids.slice(-limit).reverse();
    const bets = await Promise.all(slice.map((i) => this.casino.getBet(i).then((b) => ({ id: i, ...b }))));
    return bets;
  }

  async getGameMeta() {
    const meta = [];
    for (let g = 0; g < 6; g++) {
      meta.push({
        game: g,
        maxBet: await this.casino.gameMaxBet(g),
        paused: await this.casino.gamePaused(g),
        houseEdgeBps: await this.casino.houseEdgeBps(g),
      });
    }
    return meta;
  }

  // Live feed: subscribe to BetSettled events and call cb for each.
  subscribeBetSettled(cb) {
    const filter = this.casino.filters.BetSettled();
    const handler = (...args) => {
      const ev = args[args.length - 1];
      cb({
        betId: args[0],
        player: args[1],
        game: Number(args[2]),
        won: args[3],
        payout: args[4],
        randomness: args[5],
        serverSeed: args[6],
        clientSeed: args[7],
        blockHash: args[8],
        nonce: args[9],
        resultData: args[10],
        txHash: ev?.log?.transactionHash,
      });
    };
    this.casino.on(filter, handler);
    return () => this.casino.off(filter, handler);
  }

  // Provably fair verifier - reproduces randomness from on-chain components.
  static verifyRandomness({ serverSeed, clientSeed, blockHash, nonce }) {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "bytes32", "bytes32", "uint256"],
      [serverSeed, clientSeed, blockHash, nonce]
    );
  }
}
