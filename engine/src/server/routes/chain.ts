import { Hono } from 'hono';
import { desc } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { chainAnchors } from '../../db/schema.js';
import { getChainConfig } from '@nomus/chain';

export const chainRoutes = new Hono();

// Public — anchor history
chainRoutes.get('/history', (c) => {
  const db = getDb();
  const anchors = db.select().from(chainAnchors)
    .orderBy(desc(chainAnchors.anchoredAt))
    .limit(50)
    .all();

  return c.json({
    configured: !!getChainConfig(),
    count: anchors.length,
    anchors,
  });
});

// Public — verify a hash
chainRoutes.get('/verify/:hash', async (c) => {
  const hash = c.req.param('hash');
  const db = getDb();

  // Check local DB first
  const local = db.select().from(chainAnchors).all()
    .find((a) => a.stateHash === hash);

  if (!local) {
    return c.json({ verified: false, message: 'Hash not found in anchor history' });
  }

  // If chain is configured, verify on-chain too
  const config = getChainConfig();
  if (config) {
    try {
      const { verifyOnChain } = await import('@nomus/chain');
      const onChain = await verifyOnChain(hash);
      return c.json({
        verified: true,
        local: {
          txHash: local.txHash,
          blockNumber: local.blockNumber,
          anchoredAt: local.anchoredAt,
          ruleCount: local.ruleCount,
        },
        onChain,
      });
    } catch {
      return c.json({
        verified: true,
        local: {
          txHash: local.txHash,
          blockNumber: local.blockNumber,
          anchoredAt: local.anchoredAt,
          ruleCount: local.ruleCount,
        },
        onChain: null,
        note: 'On-chain verification unavailable',
      });
    }
  }

  return c.json({
    verified: true,
    local: {
      txHash: local.txHash,
      blockNumber: local.blockNumber,
      anchoredAt: local.anchoredAt,
      ruleCount: local.ruleCount,
    },
    onChain: null,
    note: 'Blockchain not configured',
  });
});
