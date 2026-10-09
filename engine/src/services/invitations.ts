import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { getResendApiKey } from './notifications.js';

/**
 * Inviting a user with a temporary password. Shared by the platform-admin
 * user routes (POST /api/v1/users) and the Org Admin invite
 * (POST /api/v1/cpg/users) so both behave identically: same temporary
 * password format, same bcrypt cost, same invitation email, and the
 * temporary password is never logged.
 */

export async function makeTemporaryPassword(password?: string): Promise<{ tempPassword: string; passwordHash: string }> {
  const tempPassword = password || `nomus-${randomUUID().slice(0, 8)}`;
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  return { tempPassword, passwordHash };
}

/** Send the invitation email when an email provider is configured (non-blocking). */
export function sendInvitationEmail(input: { email: string; tempPassword: string; orgName: string | null }): void {
  const config = env();
  const appUrl = config.NOMUS_CORS_ORIGIN;
  const resendKey = getResendApiKey();
  if (resendKey) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.NOMUS_FROM_EMAIL,
        to: input.email,
        subject: `You've been invited to Nomus — ${input.orgName ?? 'Your Organization'}`,
        html: `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
          <h2 style="color:#0a0b0f;">Welcome to Nomus</h2>
          <p style="color:#374151;font-size:15px;">You've been invited to <strong>${input.orgName ?? 'your organization'}</strong> on Nomus, the AI regulatory applicability engine.</p>
          <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Your login credentials:</p>
            <p style="margin:0 0 4px;font-size:14px;"><strong>Email:</strong> ${input.email}</p>
            <p style="margin:0;font-size:14px;"><strong>Temporary Password:</strong> ${input.tempPassword}</p>
          </div>
          <p style="color:#374151;font-size:15px;">You'll be asked to create a new password when you first sign in. You can also sign in with Google or GitHub.</p>
          <a href="${appUrl}/login" style="display:inline-block;padding:12px 24px;background:#00e5a0;color:#0a0b0f;text-decoration:none;border-radius:8px;font-weight:600;margin-top:8px;">Sign In to Nomus</a>
          <p style="color:#9ca3af;font-size:11px;margin-top:24px;">Nomus — Regulatory monitoring, not legal advice.</p>
        </div>`,
      }),
    }).catch((err) => {
      logger.error({ error: (err as Error).message }, 'Failed to send invitation email');
    });
  } else {
    // SECURITY: never log the temp password — this branch fires whenever
    // NOMUS_RESEND_API_KEY is unset, which can happen in production.
    logger.info({ email: input.email }, 'Invitation email not sent (no email provider configured); temp password returned in API response only');
  }
}

export function invitationMessage(): string {
  return getResendApiKey()
    ? 'User created; an invitation email is being sent. They must set a new password on first login.'
    : 'User created. No email provider is configured, so share the temporary password with them directly. They must set a new password on first login.';
}
