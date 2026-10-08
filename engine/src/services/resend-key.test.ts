// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * The Resend key saved on the Notifications page is stored encrypted; the
 * sender used the stored ciphertext as the Bearer token, so every email
 * failed once a key was saved there (end-to-end audit).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { platformSettings } from '../db/schema.js';
import { encryptForStorage } from '../core/crypto.js';
import { getResendApiKey, invalidateNotificationCache, isEmailConfigured } from './notifications.js';

beforeAll(() => runMigrations());

describe('getResendApiKey', () => {
  it('decrypts the key saved in platform settings', () => {
    getDb().insert(platformSettings).values({
      key: 'notification.apiKeys.resend', value: encryptForStorage('re_test_key_123'), updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({ target: platformSettings.key, set: { value: encryptForStorage('re_test_key_123') } }).run();
    invalidateNotificationCache();
    expect(getResendApiKey()).toBe('re_test_key_123');
    expect(isEmailConfigured()).toBe(true);
  });
});
