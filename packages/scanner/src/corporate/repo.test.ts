import { describe, it, expect } from 'vitest';
import { canonicalRepo, canonicalRepoPattern, isCanonicalRepo } from './repo.js';

// Design spec §10.5: the editor, CI and the server name a repository the same way.
describe('canonicalRepo', () => {
  it.each([
    ['git@github.com:Acme/Payments.git', 'acme/payments'],
    ['https://github.com/Acme/Payments', 'acme/payments'],
    ['https://github.com/Acme/Payments.git', 'acme/payments'],
    ['ssh://git@github.com/Acme/Payments', 'acme/payments'],
    ['ssh://git@github.com:22/Acme/Payments.git', 'acme/payments'],
    ['Acme/Payments', 'acme/payments'],
    ['github.com/Acme/Payments', 'acme/payments'],
    ['https://gitlab.example.org/Team/Service.git', 'gitlab.example.org/team/service'],
    ['git@gitlab.example.org:Team/Service.git', 'gitlab.example.org/team/service'],
    ['https://github.com/Gate-Example/Policy-Repo.git', 'gate-example/policy-repo'],
  ])('%s → %s', (input, want) => {
    expect(canonicalRepo(input)).toBe(want);
    expect(isCanonicalRepo(want)).toBe(true);
  });

  it.each([
    [''], ['payments'], ['https://github.com/acme'], ['https://github.com/a/b/c'], ['ftp://github.com/a/b'],
    ['../acme/payments'], ['acme/../payments'], ['a/b/c/d'], ['file:///home/me/repo'],
  ])('rejects %s', (input) => {
    expect(canonicalRepo(input)).toBeNull();
  });
});

describe('canonicalRepoPattern', () => {
  it.each([
    ['github.com/acme/payments', 'acme/payments'],
    ['github.com/acme/*', 'acme/*'],
    ['github.com/{acme,beta}/api-*', '{acme,beta}/api-*'],
    ['acme/*', 'acme/*'],
    ['gitlab.example.org/team/**', 'gitlab.example.org/team/**'],
    ['**', '**'],
    ['github.com/*', null],
    ['github.com/**', null],
    ['github.com/acme/**', null],
    ['github.com/acme/payments/extra', null],
  ])('%s → %s', (input, want) => {
    expect(canonicalRepoPattern(input)).toBe(want);
  });
});
