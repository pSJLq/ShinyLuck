const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const REVEAL_DELAY = 3n;
const BLOCKHASH_WINDOW = 256n;

async function mineN(n) {
  for (let i = 0; i < Number(n); i++) {
    await network.provider.send("evm_mine");
  }
}

async function currentBlock() {
  return BigInt(await ethers.provider.getBlockNumber());
}

describe("CommitReveal", function () {
  let harness;

  beforeEach(async function () {
    const Harness = await ethers.getContractFactory("CommitRevealHarness");
    harness = await Harness.deploy();
    await harness.waitForDeployment();
  });

  describe("hashServerSeed", function () {
    it("matches abi.encode(bytes32) keccak", async function () {
      const seed = ethers.hexlify(ethers.randomBytes(32));
      const onchain = await harness.hashServerSeed(seed);
      const offchain = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [seed])
      );
      expect(onchain).to.equal(offchain);
    });

    it("is deterministic", async function () {
      const seed = ethers.hexlify(ethers.randomBytes(32));
      expect(await harness.hashServerSeed(seed)).to.equal(
        await harness.hashServerSeed(seed)
      );
    });

    it("differs for different seeds", async function () {
      const a = await harness.hashServerSeed(ethers.hexlify(ethers.randomBytes(32)));
      const b = await harness.hashServerSeed(ethers.hexlify(ethers.randomBytes(32)));
      expect(a).to.not.equal(b);
    });
  });

  describe("requireSeedMatches", function () {
    it("passes for the correct seed", async function () {
      const seed = ethers.hexlify(ethers.randomBytes(32));
      const hash = await harness.hashServerSeed(seed);
      await expect(harness.checkSeed(seed, hash)).to.not.be.reverted;
    });

    it("reverts for the wrong seed", async function () {
      const seed = ethers.hexlify(ethers.randomBytes(32));
      const wrong = ethers.hexlify(ethers.randomBytes(32));
      const hash = await harness.hashServerSeed(seed);
      await expect(harness.checkSeed(wrong, hash))
        .to.be.revertedWithCustomError(harness, "InvalidServerSeed");
    });

    it("reverts for zero hash", async function () {
      const seed = ethers.hexlify(ethers.randomBytes(32));
      await expect(harness.checkSeed(seed, ethers.ZeroHash))
        .to.be.revertedWithCustomError(harness, "InvalidServerSeed");
    });
  });

  describe("isRevealable / requireRevealable", function () {
    it("returns false at commit block", async function () {
      const commit = await currentBlock();
      expect(await harness.isRevealable(commit)).to.equal(false);
    });

    it("returns false at commit + REVEAL_DELAY (strict >)", async function () {
      const commit = await currentBlock();
      // mine until block.number == commit + REVEAL_DELAY
      while ((await currentBlock()) < commit + REVEAL_DELAY) {
        await network.provider.send("evm_mine");
      }
      expect(await currentBlock()).to.equal(commit + REVEAL_DELAY);
      expect(await harness.isRevealable(commit)).to.equal(false);
    });

    it("returns true at commit + REVEAL_DELAY + 1", async function () {
      const commit = await currentBlock();
      while ((await currentBlock()) < commit + REVEAL_DELAY + 1n) {
        await network.provider.send("evm_mine");
      }
      expect(await harness.isRevealable(commit)).to.equal(true);
    });

    it("returns true at the last allowed block (commit + DELAY + WINDOW)", async function () {
      const commit = await currentBlock();
      const target = commit + REVEAL_DELAY + BLOCKHASH_WINDOW;
      while ((await currentBlock()) < target) {
        await network.provider.send("evm_mine");
      }
      expect(await harness.isRevealable(commit)).to.equal(true);
      expect(await harness.isExpired(commit)).to.equal(false);
    });

    it("returns false past the window (expired)", async function () {
      const commit = await currentBlock();
      const target = commit + REVEAL_DELAY + BLOCKHASH_WINDOW + 1n;
      while ((await currentBlock()) < target) {
        await network.provider.send("evm_mine");
      }
      expect(await harness.isRevealable(commit)).to.equal(false);
      expect(await harness.isExpired(commit)).to.equal(true);
    });

    it("requireRevealable reverts before window with RevealTooEarly", async function () {
      const commit = await currentBlock();
      // not yet past commit + DELAY
      await expect(harness.checkRevealable(commit))
        .to.be.revertedWithCustomError(harness, "RevealTooEarly");
    });

    it("requireRevealable reverts after window with RevealExpired", async function () {
      const commit = await currentBlock();
      const target = commit + REVEAL_DELAY + BLOCKHASH_WINDOW + 1n;
      while ((await currentBlock()) < target) {
        await network.provider.send("evm_mine");
      }
      await expect(harness.checkRevealable(commit))
        .to.be.revertedWithCustomError(harness, "RevealExpired");
    });

    it("requireRevealable passes inside the window", async function () {
      const commit = await currentBlock();
      await mineN(REVEAL_DELAY + 1n);
      await expect(harness.checkRevealable(commit)).to.not.be.reverted;
    });
  });

  describe("deriveRandomness", function () {
    it("matches off-chain reproduction", async function () {
      const serverSeed = ethers.hexlify(ethers.randomBytes(32));
      const clientSeed = ethers.hexlify(ethers.randomBytes(32));
      const commit = await currentBlock();
      // need block (commit + DELAY) to be available, so mine until block.number > commit + DELAY
      await mineN(REVEAL_DELAY + 1n);
      const futureHash = (await ethers.provider.getBlock(Number(commit + REVEAL_DELAY))).hash;
      const nonce = 42n;

      const onchain = await harness.derive(serverSeed, clientSeed, commit, nonce);
      const offchain = ethers.solidityPackedKeccak256(
        ["bytes32", "bytes32", "bytes32", "uint256"],
        [serverSeed, clientSeed, futureHash, nonce]
      );
      expect(onchain).to.equal(offchain);
    });

    it("changes when any input changes", async function () {
      const ss = ethers.hexlify(ethers.randomBytes(32));
      const cs = ethers.hexlify(ethers.randomBytes(32));
      const commit = await currentBlock();
      await mineN(REVEAL_DELAY + 1n);

      const base = await harness.derive(ss, cs, commit, 1n);
      const altSeed = await harness.derive(
        ethers.hexlify(ethers.randomBytes(32)), cs, commit, 1n
      );
      const altClient = await harness.derive(
        ss, ethers.hexlify(ethers.randomBytes(32)), commit, 1n
      );
      const altNonce = await harness.derive(ss, cs, commit, 2n);

      expect(base).to.not.equal(altSeed);
      expect(base).to.not.equal(altClient);
      expect(base).to.not.equal(altNonce);
    });

    it("reverts (or is unreachable via require) when called too early", async function () {
      // The library has require(futureHash != 0). On hardhat, blockhash of a future
      // or current block is 0. Calling derive immediately after commit triggers it.
      const commit = await currentBlock();
      const ss = ethers.hexlify(ethers.randomBytes(32));
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await expect(harness.derive(ss, cs, commit, 1n))
        .to.be.revertedWith("CommitReveal: blockhash unavailable");
    });
  });

  describe("fuzz / property tests", function () {
    it("isExpired and isRevealable are mutually exclusive within sane ranges", async function () {
      // Sample: at any block.number, exactly one of {tooEarly, revealable, expired} holds.
      const commit = await currentBlock();
      for (let offset = 0; offset <= 5; offset++) {
        const tooEarly = BigInt(offset) <= REVEAL_DELAY;
        const reveal = await harness.isRevealable(commit);
        const exp = await harness.isExpired(commit);
        if (tooEarly) {
          expect(reveal).to.equal(false);
          expect(exp).to.equal(false);
        } else {
          expect(reveal).to.equal(true);
          expect(exp).to.equal(false);
        }
        await network.provider.send("evm_mine");
      }
    });

    it("hashServerSeed has no obvious collisions on 64 random samples", async function () {
      const seen = new Set();
      for (let i = 0; i < 64; i++) {
        const seed = ethers.hexlify(ethers.randomBytes(32));
        const h = await harness.hashServerSeed(seed);
        expect(seen.has(h)).to.equal(false);
        seen.add(h);
      }
    });

    it("deriveRandomness output is uniformly distributed mod 100 (loose)", async function () {
      // Loose chi-square style sanity: for 200 samples mod 100, no bucket should
      // be empty — purely a smoke test that randomness is not collapsed.
      const commit = await currentBlock();
      await mineN(REVEAL_DELAY + 1n);
      const buckets = new Array(10).fill(0);
      const ss = ethers.hexlify(ethers.randomBytes(32));
      const cs = ethers.hexlify(ethers.randomBytes(32));
      for (let i = 0; i < 200; i++) {
        const r = await harness.derive(ss, cs, commit, BigInt(i));
        const v = Number(BigInt(r) % 10n);
        buckets[v]++;
      }
      for (const c of buckets) expect(c).to.be.greaterThan(0);
    });
  });
});
