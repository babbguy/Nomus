import { Hono } from 'hono';
import type { AppEnv } from '../../app.js';
import { cpgMeRoutes } from './me.js';
import { cpgRbacRoutes } from './rbac.js';
import { cpgSettingsRoutes } from './settings.js';
import { cpgAuditRoutes } from './audit.js';
import { cpgBoardRoutes } from './boards.js';
import { cpgQuorumRoutes } from './quorum.js';
import { cpgPolicyRoutes } from './policies.js';
import { cpgBundleRoutes } from './bundle.js';
import { cpgCaseRoutes } from './cases.js';
import { cpgProposalRoutes } from './proposals.js';
import { cpgCiRoutes } from './ci.js';
import { cpgIntegrationRoutes } from './integrations.js';

/**
 * Corporate Policy Governance API, mounted at /api/v1/cpg (design spec §9).
 * Every route is guarded by cpgAuth() (helpers.ts), and responses are parsed
 * with their zod contract from cpg/contracts.ts before they are sent.
 */
export const cpgRoutes = new Hono<AppEnv>();

cpgRoutes.route('/me', cpgMeRoutes);
cpgRoutes.route('/settings', cpgSettingsRoutes);
cpgRoutes.route('/audit', cpgAuditRoutes);
cpgRoutes.route('/boards', cpgBoardRoutes);
cpgRoutes.route('/quorum', cpgQuorumRoutes);
cpgRoutes.route('/bundle', cpgBundleRoutes);
cpgRoutes.route('/ci', cpgCiRoutes);
cpgRoutes.route('/', cpgCaseRoutes);
cpgRoutes.route('/', cpgProposalRoutes);
cpgRoutes.route('/', cpgPolicyRoutes);
cpgRoutes.route('/', cpgRbacRoutes);
cpgRoutes.route('/', cpgIntegrationRoutes);
