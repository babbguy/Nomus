# @nomus/chain

Optional blockchain attestation library for Nomus. Anchors state hashes on the Polygon network and verifies them on-chain, providing tamper-evident timestamps for attestations.

Built with ethers.js v6. Interacts with the `NomusAnchor` smart contract. This is a workspace-internal package (`private: true`, not published to npm); the engine consumes it through npm workspaces.

## Quick Start

```typescript
import { anchorStateHash, verifyOnChain, getLatestAnchor } from '@nomus/chain';

// Anchor a state hash on-chain
const result = await anchorStateHash(stateHash, ruleCount);
// => { txHash, blockNumber, stateHash, ruleCount, timestamp }

// Verify a state hash exists on-chain
const verification = await verifyOnChain(stateHash);
// => { exists, ruleCount, timestamp, blockTimestamp }

// Get the latest anchor
const latest = await getLatestAnchor();
// => { stateHash, ruleCount, timestamp }
```

## Configuration

Set these environment variables to enable chain features. They are read directly from the process environment (they are not part of the engine's validated config schema). If any are missing, `anchorStateHash` returns `null` (chain is optional) and the engine's daily anchor job skips with a log message.

| Variable | Description |
|----------|-------------|
| `NOMUS_POLYGON_RPC_URL` | Polygon JSON-RPC endpoint |
| `NOMUS_POLYGON_PRIVATE_KEY` | Wallet private key for signing transactions |
| `NOMUS_POLYGON_CONTRACT` | Deployed `NomusAnchor` contract address |

## Architecture

```
src/
  index.ts        Barrel exports
  anchor.ts       anchorStateHash() -- writes a state hash + rule count to the contract
  verify.ts       verifyOnChain() -- reads and verifies a state hash from the contract
                  getLatestAnchor() -- retrieves the most recent anchor
  config.ts       Reads chain config from environment, defines the contract ABI
  contract.sol    Solidity source for the NomusAnchor contract
```

### Smart Contract Interface

The `NomusAnchor` contract exposes:

- `anchor(bytes32 _stateHash, uint256 _ruleCount)` -- Store a new attestation anchor
- `verify(bytes32 _stateHash) returns (bool exists, uint256 ruleCount, uint256 timestamp)` -- Check if a hash was anchored
- `getLatest() returns (bytes32 stateHash, uint256 ruleCount, uint256 timestamp)` -- Get the most recent anchor
- `totalAnchors() returns (uint256)` -- Total number of anchors stored
- `HashAnchored` event -- Emitted on each anchor

### State Hash Format

State hashes must be 64 hex characters (32 bytes). The `0x` prefix is handled automatically. Invalid hashes throw an error.

## Build

```bash
# from the repository root
npm run build:chain      # or: npm run build -w packages/chain  (tsc)
```

## Key Files

| File | Purpose |
|------|---------|
| `src/anchor.ts` | Writes state hashes to the Polygon contract |
| `src/verify.ts` | Reads and verifies state hashes from the contract |
| `src/config.ts` | Chain configuration and contract ABI |
| `src/contract.sol` | Solidity source for the NomusAnchor contract |
