import { ethers } from 'ethers';
import { getChainConfig, ANCHOR_ABI } from './config.js';

export interface VerifyResult {
  exists: boolean;
  ruleCount: number;
  timestamp: number;
  blockTimestamp: string;
}

/**
 * Verify a state hash exists on-chain.
 */
export async function verifyOnChain(stateHash: string): Promise<VerifyResult | null> {
  const config = getChainConfig();
  if (!config) return null;

  // Validate stateHash is a valid hex string (64 hex chars = 32 bytes)
  const normalized = stateHash.startsWith('0x') ? stateHash.slice(2) : stateHash;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`Invalid stateHash: expected 64 hex characters, got "${stateHash}"`);
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const contract = new ethers.Contract(config.contractAddress, ANCHOR_ABI, provider);

  // Guard against double 0x prefix
  const hashBytes = '0x' + normalized;

  try {
    const [exists, ruleCount, timestamp] = await contract.verify(hashBytes);

    return {
      exists,
      ruleCount: Number(ruleCount),
      timestamp: Number(timestamp),
      blockTimestamp: exists ? new Date(Number(timestamp) * 1000).toISOString() : '',
    };
  } catch (err) {
    throw new Error(
      `Failed to verify state hash on-chain: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Get the latest anchor from the contract.
 */
export async function getLatestAnchor(): Promise<{
  stateHash: string;
  ruleCount: number;
  timestamp: string;
} | null> {
  const config = getChainConfig();
  if (!config) return null;

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const contract = new ethers.Contract(config.contractAddress, ANCHOR_ABI, provider);

  try {
    const [stateHash, ruleCount, timestamp] = await contract.getLatest();
    return {
      stateHash: stateHash.slice(2), // Remove 0x prefix
      ruleCount: Number(ruleCount),
      timestamp: new Date(Number(timestamp) * 1000).toISOString(),
    };
  } catch {
    return null; // No anchors yet
  }
}
