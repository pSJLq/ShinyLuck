const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deriveDeck } = require("../scripts/lib/poker-deck");

// Guards that the off-chain bot's JS shuffle reproduces the on-chain dealer's
// deck exactly. If this ever fails, players would be dealt the wrong cards.
describe("Poker deck parity — JS bot vs on-chain dealer", function () {
  async function setup() {
    const [owner] = await ethers.getSigners();
    const Dealer = await ethers.getContractFactory("CommitRevealDealer");
    const dealer = await Dealer.deploy(owner.address);
    await dealer.waitForDeployment();
    return dealer;
  }

  it("produces identical decks across many random inputs", async function () {
    const dealer = await loadFixture(setup);
    for (let n = 0; n < 8; n++) {
      const seed = ethers.hexlify(ethers.randomBytes(32));
      const entropy = ethers.hexlify(ethers.randomBytes(32));
      const handId = BigInt(Math.floor(Math.random() * 1e6));
      const tableId = BigInt(Math.floor(Math.random() * 256));

      const onchain = (await dealer.recomputeDeck(seed, entropy, handId, tableId)).map(Number);
      const offchain = deriveDeck(seed, entropy, handId, tableId);
      expect(offchain).to.deep.equal(onchain);
    }
  });
});
