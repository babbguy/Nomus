import { ethers } from 'ethers';
import { getChainConfig, ANCHOR_ABI } from './config.js';

export interface AnchorResult {
  txHash: string;
  blockNumber: number;
  stateHash: string;
  ruleCount: number;
  timestamp: string;
}

/**
 * Anchor a state hash on the Polygon blockchain.
 * Returns the transaction details or null if chain is not configured.
 */
export async function anchorStateHash(
  stateHash: string,
  ruleCount: number,
): Promise<AnchorResult | null> {
  const config = getChainConfig();
  if (!config) return null;

  // Validate stateHash is a valid hex string (64 hex chars = 32 bytes)
  const normalized = stateHash.startsWith('0x') ? stateHash.slice(2) : stateHash;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`Invalid stateHash: expected 64 hex characters, got "${stateHash}"`);
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const contract = new ethers.Contract(config.contractAddress, ANCHOR_ABI, wallet);

  // Convert hex string to bytes32 — guard against double 0x prefix
  const hashBytes = '0x' + normalized;

  try {
    const tx = await contract.anchor(hashBytes, ruleCount);
    const receipt = await tx.wait();

    if (!receipt) {
      throw new Error('Transaction was not mined — tx.wait() returned null');
    }

    return {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      stateHash: normalized,
      ruleCount,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    throw new Error(
      `Failed to anchor state hash on-chain: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
