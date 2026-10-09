import type { Context, Handler } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../../app.js';
import { safeJson } from '../../utils.js';
import { CpgError, cpgErrorResponse, invalidInput } from '../../../cpg/errors.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { can, type CpgActor } from '../../../cpg/rbac/can.js';
import type { PermissionKey } from '../../../cpg/rbac/catalog.js';
import { getOrgSettings } from '../../../cpg/rbac/seed.js';

/** Parse a JSON body with a strict zod schema; throws CpgError (400 invalid_json / invalid_input). */
export async function parseBody<S extends z.ZodTypeAny>(c: Context<AppEnv>, schema: S): Promise<z.infer<S>> {
  const { data, error } = await safeJson(c);
  if (error !== null) throw new CpgError(400, 'invalid_json', error);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw invalidInput(parsed.error);
  return parsed.data;
}

/** Parse the query string with a strict zod schema. */
export function parseQuery<S extends z.ZodTypeAny>(c: Context<AppEnv>, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw invalidInput(parsed.error);
  return parsed.data;
}

/** Wrap a handler so a thrown CpgError becomes the CPG error envelope. Anything else propagates (500). */
export function handle(fn: (c: Context<AppEnv>) => Response | Promise<Response>): Handler<AppEnv> {
  return async (c) => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof CpgError) return cpgErrorResponse(c, err);
      throw err;
    }
  };
}

/** The actor loaded by requireCpgPermission. */
export function actorFrom(c: Context<AppEnv>): CpgActor {
  const actor = c.get('cpgActor');
  if (!actor) throw new CpgError(401, 'unauthenticated', 'Authentication required');
  return actor;
}

/** The audit actor string for the caller (`user:<id>`). */
export function auditActor(c: Context<AppEnv>): string {
  return `user:${actorFrom(c).userId}`;
}

/** A required path parameter (handlers wrapped by handle() lose Hono's path typing). */
export function pathParam(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new CpgError(404, 'not_found', 'Not found');
  return value;
}

/** 403 forbidden unless the actor holds `permission` (on `repo`, when given, so scoped grants count). */
export function requirePermission(actor: CpgActor, permission: PermissionKey, repo?: string): void {
  if (!can(actor, permission, repo ? { repo } : undefined)) throw new CpgError(403, 'forbidden', `Missing permission ${permission}`, { permission });
}

/** Writes need corporate policies enabled for the org (403 cpg_disabled). */
export function requireEnabled(db: BetterSQLite3Database<any>, orgId: string): void {
  if (!getOrgSettings(db, orgId)?.enabled) throw new CpgError(403, 'cpg_disabled', 'Corporate policies are not enabled for this organization');
}
