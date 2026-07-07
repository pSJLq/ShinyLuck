// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ZkVerify — BN254 (alt_bn128 G1) verification primitives for ShinyPoker
///        zkShuffle v2 mental poker, done with the EVM's native EC precompiles.
/// @notice Every proof produced by frontend/poker/zk-bn254.js verifies here
///         UNCHANGED — the Fiat–Shamir challenge is hashed with the same
///         abi.encodePacked layout on both sides. This is what makes the v2
///         card protocol verifiable ON-CHAIN, during the hand, by anyone.
library ZkVerify {
    // BN254 G1 group (scalar field) order r.
    uint256 internal constant R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct G1Point {
        uint256 x;
        uint256 y;
    }

    /// The fixed generator G = (1, 2) — identical to the alt_bn128 precompile base.
    function gen() internal pure returns (G1Point memory) {
        return G1Point(1, 2);
    }

    function isZero(G1Point memory p) internal pure returns (bool) {
        return p.x == 0 && p.y == 0;
    }

    function eq(G1Point memory a, G1Point memory b) internal pure returns (bool) {
        return a.x == b.x && a.y == b.y;
    }

    /// P + Q via the ecAdd precompile (0x06).
    function add(G1Point memory p, G1Point memory q) internal view returns (G1Point memory r) {
        uint256[4] memory input = [p.x, p.y, q.x, q.y];
        bool ok;
        assembly {
            ok := staticcall(gas(), 0x06, input, 0x80, r, 0x40)
        }
        require(ok, "ecAdd");
    }

    /// s·P via the ecMul precompile (0x07). The precompile reduces s mod r.
    function mul(G1Point memory p, uint256 s) internal view returns (G1Point memory r) {
        uint256[3] memory input = [p.x, p.y, s];
        bool ok;
        assembly {
            ok := staticcall(gas(), 0x07, input, 0x60, r, 0x40)
        }
        require(ok, "ecMul");
    }

    // ---- Fiat–Shamir challenges (byte-identical to zk-bn254.js) ------------

    /// Schnorr challenge: H(domain ‖ X ‖ R) mod r.
    function schnorrChallenge(string memory domain, G1Point memory X, G1Point memory Rp)
        internal
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encodePacked(domain, X.x, X.y, Rp.x, Rp.y))) % R;
    }

    /// Chaum–Pedersen challenge: H(domain ‖ A ‖ X ‖ d ‖ R1 ‖ R2) mod r.
    function cpChallenge(
        string memory domain,
        G1Point memory A,
        G1Point memory X,
        G1Point memory d,
        G1Point memory R1,
        G1Point memory R2
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(domain, A.x, A.y, X.x, X.y, d.x, d.y, R1.x, R1.y, R2.x, R2.y))) % R;
    }

    // ---- proof verification ------------------------------------------------

    /// Schnorr proof of knowledge of x with X = x·G: s·G == R + c·X.
    function verifySchnorr(string memory domain, G1Point memory X, G1Point memory Rp, uint256 s)
        internal
        view
        returns (bool)
    {
        uint256 c = schnorrChallenge(domain, X, Rp);
        G1Point memory lhs = mul(gen(), s);
        G1Point memory rhs = add(Rp, mul(X, c));
        return eq(lhs, rhs);
    }

    /// Chaum–Pedersen proof that log_G(X) == log_A(d) (i.e. d = x·A honestly):
    /// s·G == R1 + c·X  AND  s·A == R2 + c·d.
    function verifyChaumPedersen(
        string memory domain,
        G1Point memory A,
        G1Point memory X,
        G1Point memory d,
        G1Point memory R1,
        G1Point memory R2,
        uint256 s
    ) internal view returns (bool) {
        uint256 c = cpChallenge(domain, A, X, d, R1, R2);
        if (!eq(mul(gen(), s), add(R1, mul(X, c)))) return false;
        if (!eq(mul(A, s), add(R2, mul(d, c)))) return false;
        return true;
    }

    /// ElGamal re-mask used by the on-chain shuffle audit: given ct=(A,B) and
    /// the table key X, remask with rho → (A + rho·G, B + rho·X).
    function remask(G1Point memory A, G1Point memory B, G1Point memory X, uint256 rho)
        internal
        view
        returns (G1Point memory, G1Point memory)
    {
        return (add(A, mul(gen(), rho)), add(B, mul(X, rho)));
    }
}
