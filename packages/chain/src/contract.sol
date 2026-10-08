// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * NomusAnchor — Immutable state hash registry on Polygon.
 * Stores daily SHA-256 hashes of Nomus's policy rule database.
 * Provides cryptographic proof that data existed at a specific point in time.
 * Cost: ~$0.01 per anchor on Polygon mainnet.
 */
contract NomusAnchor {
    address public owner;

    struct Anchor {
        bytes32 stateHash;
        uint256 ruleCount;
        uint256 timestamp;
    }

    Anchor[] public anchors;
    mapping(bytes32 => uint256) public hashToIndex;

    event HashAnchored(bytes32 indexed stateHash, uint256 ruleCount, uint256 timestamp, uint256 index);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function anchor(bytes32 _stateHash, uint256 _ruleCount) external onlyOwner {
        uint256 index = anchors.length;
        anchors.push(Anchor(_stateHash, _ruleCount, block.timestamp));
        hashToIndex[_stateHash] = index + 1; // +1 so 0 means "not found"
        emit HashAnchored(_stateHash, _ruleCount, block.timestamp, index);
    }

    function verify(bytes32 _stateHash) external view returns (bool exists, uint256 ruleCount, uint256 timestamp) {
        uint256 idx = hashToIndex[_stateHash];
        if (idx == 0) return (false, 0, 0);
        Anchor memory a = anchors[idx - 1];
        return (true, a.ruleCount, a.timestamp);
    }

    function getLatest() external view returns (bytes32 stateHash, uint256 ruleCount, uint256 timestamp) {
        require(anchors.length > 0, "No anchors");
        Anchor memory a = anchors[anchors.length - 1];
        return (a.stateHash, a.ruleCount, a.timestamp);
    }

    function totalAnchors() external view returns (uint256) {
        return anchors.length;
    }
}
