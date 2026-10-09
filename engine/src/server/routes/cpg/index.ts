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

/**
 * Corporate Policy Governance API, mounted at /api/v1/cpg (design spec §9).
 *
 * Every route applies, in order: requireSessionOrApiKey(...) (so the
 * temporary-password block fires first), rateLimit(), then
 * requireCpgPermission(...). Responses are parsed with their zod contract
 * from cpg/contracts.ts before they are sent.
 */
export const cpgRoutes = new Hono<AppEnv>();

cpgRoutes.route('/me', cpgMeRoutes);
cpgRoutes.route('/settings', cpgSettingsRoutes);
cpgRoutes.route('/audit', cpgAuditRoutes);
cpgRoutes.route('/boards', cpgBoardRoutes);
cpgRoutes.route('/quorum', cpgQuorumRoutes);
cpgRoutes.route('/bundle', cpgBundleRoutes);
cpgRoutes.route('/', cpgPolicyRoutes);
cpgRoutes.route('/', cpgRbacRoutes);
