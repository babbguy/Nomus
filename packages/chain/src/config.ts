export interface ChainConfig {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
}

export function getChainConfig(): ChainConfig | null {
  const rpcUrl = process.env.NOMUS_POLYGON_RPC_URL;
  const privateKey = process.env.NOMUS_POLYGON_PRIVATE_KEY;
  const contractAddress = process.env.NOMUS_POLYGON_CONTRACT;

  if (!rpcUrl || !privateKey || !contractAddress) {
    return null;
  }

  return { rpcUrl, privateKey, contractAddress };
}

// Minimal ABI for the NomusAnchor contract
export const ANCHOR_ABI = [
  'function anchor(bytes32 _stateHash, uint256 _ruleCount) external',
  'function verify(bytes32 _stateHash) external view returns (bool exists, uint256 ruleCount, uint256 timestamp)',
  'function getLatest() external view returns (bytes32 stateHash, uint256 ruleCount, uint256 timestamp)',
  'function totalAnchors() external view returns (uint256)',
  'event HashAnchored(bytes32 indexed stateHash, uint256 ruleCount, uint256 timestamp, uint256 index)',
];
