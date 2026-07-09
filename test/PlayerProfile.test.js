const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PlayerProfile", function () {
  let pp, a, b;

  beforeEach(async () => {
    [a, b] = await ethers.getSigners();
    const F = await ethers.getContractFactory("PlayerProfile");
    pp = await F.deploy();
    await pp.waitForDeployment();
  });

  it("claims a handle (+avatar) and reads it back, case-insensitively", async () => {
    await pp.connect(a).setProfile("Shiny_Viq", 3);
    expect(await pp.handleOf(a.address)).to.equal("Shiny_Viq");
    expect(await pp.hasHandle(a.address)).to.equal(true);
    expect(await pp.addressOfHandle("shiny_viq")).to.equal(a.address);
    const prof = await pp.profileOf(a.address);
    expect(prof.avatar).to.equal(3);
    expect(prof.since).to.be.greaterThan(0n);
  });

  it("enforces case-insensitive uniqueness across addresses", async () => {
    await pp.connect(a).setProfile("Hero", 0);
    await expect(pp.connect(b).setProfile("hero", 0)).to.be.revertedWithCustomError(pp, "HandleTaken");
    expect(await pp.handleAvailable("HERO")).to.equal(false);
    expect(await pp.handleAvailable("Villain")).to.equal(true);
  });

  it("rejects bad length and charset", async () => {
    await expect(pp.setProfile("ab", 0)).to.be.revertedWithCustomError(pp, "BadHandle"); // too short
    await expect(pp.setProfile("waytoolonghandle12345", 0)).to.be.revertedWithCustomError(pp, "BadHandle"); // 21 chars
    await expect(pp.setProfile("bad name", 0)).to.be.revertedWithCustomError(pp, "BadHandle"); // space
    await expect(pp.setProfile("dash-no", 0)).to.be.revertedWithCustomError(pp, "BadHandle"); // hyphen
  });

  it("changing handle frees the old one for others", async () => {
    await pp.connect(a).setProfile("OldName", 0);
    await pp.connect(a).setProfile("NewName", 1);
    expect(await pp.handleOf(a.address)).to.equal("NewName");
    expect(await pp.addressOfHandle("oldname")).to.equal(ethers.ZeroAddress);
    await pp.connect(b).setProfile("oldname", 0);
    expect(await pp.addressOfHandle("OldName")).to.equal(b.address);
  });

  it("lets the same user keep their handle while changing avatar", async () => {
    await pp.connect(a).setProfile("Keeper", 1);
    await pp.connect(a).setProfile("Keeper", 9);
    expect(await pp.addressOfHandle("keeper")).to.equal(a.address);
    expect((await pp.profileOf(a.address)).avatar).to.equal(9);
  });

  it("clearHandle releases it", async () => {
    await pp.connect(a).setProfile("Tmp123", 0);
    await pp.connect(a).clearHandle();
    expect(await pp.hasHandle(a.address)).to.equal(false);
    expect(await pp.addressOfHandle("tmp123")).to.equal(ethers.ZeroAddress);
  });
});
