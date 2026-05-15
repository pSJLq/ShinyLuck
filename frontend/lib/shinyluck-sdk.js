// ShinyLuck frontend SDK — vanilla JS / ESM, wraps ethers v6.
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

import { ethers } from "https://esm.sh/ethers@6.13.2";

export const CHAINS = {
  somniaTestnet: {
    chainIdHex: "0xc488", // 50312
    chainId: 50312,
    chainName: "Somnia Testnet (Shannon)",
    nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
    rpcUrls: ["https://dream-rpc.somnia.network"],
    wsUrls: ["wss://dream-rpc.somnia.network/ws", "wss://api.infra.testnet.somnia.network/ws"],
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

// Trimmed ABIs — enough to drive the frontend. For a full ABI, fetch from
// hardhat artifacts at build time.
const CASINO_ABI = [
  // per-bet games
  "function placeDiceBet(uint8 target, bool over, bytes32 clientSeed) payable returns (uint256)",
  "function placeSlotsBet(bytes32 clientSeed,bool useFreeSpin) payable returns (uint256)",
  "function placeClusterBet(bytes32 clientSeed,bool useFreeSpin) payable returns (uint256)",
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
  // events — per-bet
  "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
  "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
  "event BetRefunded(uint256 indexed betId,address indexed player,uint256 amount,string reason)",
  "event WithdrawalCredited(address indexed player,uint256 amount)",
  "event WithdrawalClaimed(address indexed player,uint256 amount)",
  "event BankrollDeposited(address indexed from,uint256 amount)",
  // events — round-based
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
  // Custom errors — ethers decodes revert data into readable names when the
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
  "function registerAgent(bytes32 strategyHash,uint256 dailyLimit,uint256 totalLimit,uint8 allowedGamesMask) payable returns (address)",
  "function pauseAgent() external",
  "function resumeAgent() external",
  "function updateAgentParams(uint256,uint256,uint8,bytes32) external",
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
  /// Called by wallet.js after Sequence sign-in too — same ABI, different
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

  // Bet placement -------------------------------------------------------

  async placeDice(target, over, valueStr) {
    const cs = this.randomClientSeed();
    const tx = await this.casino.placeDiceBet(target, over, cs, { value: ethers.parseEther(String(valueStr)) });
    return await this._extractBetId(tx, cs);
  }

  /// @notice Round-based Crash. autoCashoutX is in plain multiplier units
  ///         (e.g. 2.5 = 2.5×). Pass 0 for manual-only.
  ///         The caller MUST place during an open bet window — query
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
    const tx = await this.casino.placeSlotsBet(cs, useFreeSpin, { value });
    return await this._extractBetId(tx, cs);
  }

  /// SUGAR.LAB spin (7×7 cluster pays).
  async placeCluster(valueStr, useFreeSpin = false) {
    const cs = this.randomClientSeed();
    const value = useFreeSpin ? 0n : ethers.parseEther(String(valueStr));
    const tx = await this.casino.placeClusterBet(cs, useFreeSpin, { value });
    return await this._extractBetId(tx, cs);
  }

  async placeMines(mineCount, valueStr) {
    const cs = this.randomClientSeed();
    const tx = await this.casino.placeMinesBet(mineCount, cs, { value: ethers.parseEther(String(valueStr)) });
    return await this._extractBetId(tx, cs);
  }

  async placePlinko(risk, valueStr) {
    const cs = this.randomClientSeed();
    const tx = await this.casino.placeplinkoBet(risk, cs, { value: ethers.parseEther(String(valueStr)) });
    return await this._extractBetId(tx, cs);
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
  async waitForSettle(betId, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const handler = (id, player, game, won, payout, randomness, serverSeed, clientSeed, blockHash, nonce, resultData, ev) => {
        if (BigInt(id) === BigInt(betId)) {
          this.casino.off("BetSettled", handler);
          resolve({ id, player, game, won, payout, randomness, serverSeed, clientSeed, blockHash, nonce, resultData, txHash: ev?.log?.transactionHash });
        }
      };
      this.casino.on("BetSettled", handler);
      setTimeout(() => {
        this.casino.off("BetSettled", handler);
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

  // Provably fair verifier — reproduces randomness from on-chain components.
  static verifyRandomness({ serverSeed, clientSeed, blockHash, nonce }) {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "bytes32", "bytes32", "uint256"],
      [serverSeed, clientSeed, blockHash, nonce]
    );
  }
}
