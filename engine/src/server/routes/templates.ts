import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { policyRules } from '../../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';

export interface ComplianceTemplate {
  id: string;
  name: string;
  description: string;
  useCase: string;
  jurisdictions: string[];
  ruleFilters: {
    jurisdictions?: string[];
    categories?: string[];
    severityMin?: 'low' | 'medium' | 'high' | 'critical';
    keywords?: string[];
  };
  icon: string;
}

const SEVERITY_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const TEMPLATES: ComplianceTemplate[] = [
  {
    id: 'chatbot-global',
    name: 'Chatbot / Conversational AI',
    description: 'Transparency, disclosure, and human oversight requirements for AI-powered conversational systems deployed in EU and US markets.',
    useCase: 'chatbot',
    jurisdictions: ['EU', 'US-FED', 'NIST'],
    ruleFilters: {
      jurisdictions: ['EU', 'US-FED', 'NIST'],
      keywords: ['transparency', 'disclosure', 'human oversight', 'chatbot', 'conversational', 'interaction', 'automated decision'],
    },
    icon: 'MessageSquare',
  },
  {
    id: 'recommendation-system',
    name: 'Recommendation Engine',
    description: 'Algorithmic transparency, bias detection, and fairness requirements for recommendation and personalization systems.',
    useCase: 'recommendation',
    jurisdictions: ['EU', 'US-FED', 'NIST'],
    ruleFilters: {
      jurisdictions: ['EU', 'US-FED', 'NIST'],
      keywords: ['algorithmic', 'bias', 'fairness', 'transparency', 'profiling', 'recommendation', 'personalization'],
    },
    icon: 'Sparkles',
  },
  {
    id: 'predictive-analytics',
    name: 'Predictive Analytics / ML Models',
    description: 'High-risk AI system requirements including bias audits, impact assessments, and documentation obligations for predictive models.',
    useCase: 'predictive',
    jurisdictions: ['EU', 'US-FED', 'NIST'],
    ruleFilters: {
      jurisdictions: ['EU', 'US-FED', 'NIST'],
      keywords: ['high-risk', 'impact assessment', 'bias', 'audit', 'predictive', 'classification', 'risk assessment', 'documentation'],
      severityMin: 'medium',
    },
    icon: 'TrendingUp',
  },
  {
    id: 'computer-vision',
    name: 'Computer Vision / Biometrics',
    description: 'Biometric data handling, consent requirements, and prohibited practices for computer vision and facial recognition systems.',
    useCase: 'vision',
    jurisdictions: ['EU', 'US-FED'],
    ruleFilters: {
      jurisdictions: ['EU', 'US-FED'],
      keywords: ['biometric', 'facial', 'recognition', 'image', 'video', 'surveillance', 'prohibited', 'consent'],
      severityMin: 'high',
    },
    icon: 'Eye',
  },
  {
    id: 'credit-scoring',
    name: 'Credit Scoring / Financial AI',
    description: 'Fair lending, anti-discrimination, and explainability requirements for AI systems used in credit decisions and financial services.',
    useCase: 'finance',
    jurisdictions: ['EU', 'US-FED'],
    ruleFilters: {
      jurisdictions: ['EU', 'US-FED'],
      keywords: ['credit', 'financial', 'lending', 'discrimination', 'explainability', 'high-risk', 'fundamental rights'],
      severityMin: 'high',
    },
    icon: 'DollarSign',
  },
  {
    id: 'content-moderation',
    name: 'Content Moderation',
    description: 'Content moderation obligations, transparency reporting, and appeal mechanism requirements for AI-driven content filtering.',
    useCase: 'moderation',
    jurisdictions: ['EU', 'US-FED'],
    ruleFilters: {
      jurisdictions: ['EU', 'US-FED'],
      keywords: ['content', 'moderation', 'platform', 'transparency', 'appeal', 'removal', 'filtering'],
    },
    icon: 'Shield',
  },
  {
    id: 'eu-ai-act-full',
    name: 'EU AI Act — Full Coverage',
    description: 'Comprehensive EU AI Act compliance covering all risk tiers, prohibited practices, transparency obligations, and conformity assessment requirements.',
    useCase: 'eu-compliance',
    jurisdictions: ['EU'],
    ruleFilters: {
      jurisdictions: ['EU'],
    },
    icon: 'Globe',
  },
  {
    id: 'nist-rmf',
    name: 'NIST AI Risk Management',
    description: 'NIST AI RMF alignment including governance, risk mapping, measurement, and management functions across AI system lifecycle.',
    useCase: 'nist-compliance',
    jurisdictions: ['NIST'],
    ruleFilters: {
      jurisdictions: ['NIST'],
    },
    icon: 'BookOpen',
  },
];

function matchesTemplate(rule: { jurisdiction: string; category: string; severity: string; humanSummary: string | null; ruleKey: string }, template: ComplianceTemplate): boolean {
  const filters = template.ruleFilters;

  // Jurisdiction filter
  if (filters.jurisdictions && !filters.jurisdictions.includes(rule.jurisdiction)) {
    return false;
  }

  // Category filter
  if (filters.categories && !filters.categories.includes(rule.category)) {
    return false;
  }

  // Severity minimum
  if (filters.severityMin) {
    const ruleLevel = SEVERITY_ORDER[rule.severity] ?? 0;
    const minLevel = SEVERITY_ORDER[filters.severityMin] ?? 0;
    if (ruleLevel < minLevel) return false;
  }

  // Keyword matching (check ruleKey + humanSummary)
  if (filters.keywords && filters.keywords.length > 0) {
    const text = `${rule.ruleKey} ${rule.humanSummary ?? ''}`.toLowerCase();
    const hasMatch = filters.keywords.some((kw) => text.includes(kw.toLowerCase()));
    if (!hasMatch) return false;
  }

  return true;
}

export const templateRoutes = new Hono<AppEnv>();

templateRoutes.use('*', requireSessionOrApiKey('read:policies'));

// List all templates with rule counts
templateRoutes.get('/', (c) => {
  const db = getDb();
  const allRules = db.select({
    jurisdiction: policyRules.jurisdiction,
    category: policyRules.category,
    severity: policyRules.severity,
    humanSummary: policyRules.humanSummary,
    ruleKey: policyRules.ruleKey,
  })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  const templates = TEMPLATES.map((t) => {
    const matching = allRules.filter((r) => matchesTemplate(r, t));
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      useCase: t.useCase,
      jurisdictions: t.jurisdictions,
      icon: t.icon,
      ruleCount: matching.length,
    };
  });

  return c.json({ templates, _disclaimer: LEGAL_DISCLAIMER });
});

// Get template details with matching rules
templateRoutes.get('/:id', (c) => {
  const template = TEMPLATES.find((t) => t.id === c.req.param('id'));
  if (!template) return c.json({ error: 'Template not found' }, 404);

  const db = getDb();
  const allRules = db.select({
    id: policyRules.id,
    ruleKey: policyRules.ruleKey,
    jurisdiction: policyRules.jurisdiction,
    category: policyRules.category,
    severity: policyRules.severity,
    effect: policyRules.effect,
    humanSummary: policyRules.humanSummary,
  })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  const matching = allRules.filter((r) => matchesTemplate(r, template));

  const severityCounts: Record<string, number> = {};
  for (const r of matching) {
    severityCounts[r.severity] = (severityCounts[r.severity] ?? 0) + 1;
  }

  return c.json({
    ...template,
    ruleCount: matching.length,
    severityCounts,
    rules: matching.slice(0, 100),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Preview scan with template — returns which rules would apply
templateRoutes.get('/:id/preview', (c) => {
  const template = TEMPLATES.find((t) => t.id === c.req.param('id'));
  if (!template) return c.json({ error: 'Template not found' }, 404);

  const db = getDb();
  const allRules = db.select({
    id: policyRules.id,
    ruleKey: policyRules.ruleKey,
    jurisdiction: policyRules.jurisdiction,
    category: policyRules.category,
    severity: policyRules.severity,
    effect: policyRules.effect,
    humanSummary: policyRules.humanSummary,
  })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  const matching = allRules.filter((r) => matchesTemplate(r, template));

  return c.json({
    templateId: template.id,
    templateName: template.name,
    jurisdictions: template.jurisdictions,
    totalRules: matching.length,
    bySeverity: {
      critical: matching.filter((r) => r.severity === 'critical').length,
      high: matching.filter((r) => r.severity === 'high').length,
      medium: matching.filter((r) => r.severity === 'medium').length,
      low: matching.filter((r) => r.severity === 'low').length,
    },
    sampleRules: matching.slice(0, 10).map((r) => ({
      ruleKey: r.ruleKey,
      severity: r.severity,
      effect: r.effect,
      summary: r.humanSummary,
    })),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});
