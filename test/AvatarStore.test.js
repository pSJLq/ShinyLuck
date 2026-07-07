const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AvatarStore", () => {
  let store, a, b;

  beforeEach(async () => {
    [a, b] = await ethers.getSigners();
    store = await (await ethers.getContractFactory("AvatarStore")).deploy();
  });

  it("stores and returns raw image bytes per address", async () => {
    const img = ethers.toUtf8Bytes("RIFFfakewebpbytes");
    await expect(store.connect(a).setAvatar(img)).to.emit(store, "AvatarSet").withArgs(a.address, img.length);
    expect(ethers.getBytes(await store.avatarOf(a.address))).to.deep.equal(img);
    expect(await store.hasAvatar(a.address)).to.equal(true);
    expect(await store.hasAvatar(b.address)).to.equal(false);
  });

  it("replaces on re-set and each address is isolated", async () => {
    await store.connect(a).setAvatar(ethers.toUtf8Bytes("one"));
    await store.connect(b).setAvatar(ethers.toUtf8Bytes("two"));
    await store.connect(a).setAvatar(ethers.toUtf8Bytes("three"));
    expect(ethers.toUtf8String(await store.avatarOf(a.address))).to.equal("three");
    expect(ethers.toUtf8String(await store.avatarOf(b.address))).to.equal("two");
  });

  it("clearAvatar removes it", async () => {
    await store.connect(a).setAvatar(ethers.toUtf8Bytes("x"));
    await store.connect(a).clearAvatar();
    expect(await store.hasAvatar(a.address)).to.equal(false);
    expect(await store.avatarOf(a.address)).to.equal("0x");
  });

  it("rejects images over MAX_BYTES", async () => {
    const big = new Uint8Array(8193).fill(1);
    await expect(store.connect(a).setAvatar(big)).to.be.revertedWithCustomError(store, "TooBig");
    await store.connect(a).setAvatar(new Uint8Array(8192).fill(1)); // exactly the cap is fine
  });
});
