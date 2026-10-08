// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * articleChunk legal references on real statute layouts.
 *
 * End-to-end audit: the Illinois code prints sections as
 * "(820 ILCS 42/5) Sec. 5. ...", which was not recognised, while numbered
 * paragraphs "(1) Notify ..." were taken for EUR-Lex recitals — so Sec. 10,
 * 15 and 20 were extracted under the legal reference "3".
 */
import { describe, it, expect } from 'vitest';
import { articleChunk } from './article-chunker.js';

const ILCS = [
  '# (820 ILCS 42/) Artificial Intelligence Video Interview Act.',
  '',
  '## (820 ILCS 42/1) Sec. 1. Short title.',
  '',
  'This Act may be cited as the Artificial Intelligence Video Interview Act.',
  '',
  '## (820 ILCS 42/5) Sec. 5. Disclosure of the use of artificial intelligence analysis.',
  '',
  'An employer that asks applicants to record video interviews shall do all of the following:',
  '',
  '(1) Notify each applicant before the interview that artificial intelligence may be used.',
  '',
  '(2) Provide each applicant with information before the interview explaining how the AI works.',
  '',
  '(3) Obtain, before the interview, consent from the applicant.',
  '',
  '## (820 ILCS 42/10) Sec. 10. Sharing videos limited.',
  '',
  'An employer may not share applicant videos, except with persons whose expertise is necessary.',
  '',
  '## (820 ILCS 42/15) Sec. 15. Destruction of videos.',
  '',
  'Upon request from the applicant, employers must delete the interviews within 30 days.',
].join('\n');

describe('articleChunk', () => {
  it('splits a compiled US statute on its "Sec. N" headings, keeping numbered paragraphs in their section', () => {
    const chunks = articleChunk(ILCS);
    const refs = chunks.map((c) => c.articleRef);
    expect(refs).toEqual(expect.arrayContaining(['Sec. 1.', 'Sec. 5.', 'Sec. 10.', 'Sec. 15.']));
    expect(refs).not.toContain('1');
    expect(refs).not.toContain('3');
    const sec5 = chunks.find((c) => c.articleRef === 'Sec. 5.')!;
    expect(sec5.content).toContain('(3) Obtain, before the interview, consent');
    const sec10 = chunks.find((c) => c.articleRef === 'Sec. 10.')!;
    expect(sec10.content).toContain('may not share applicant videos');
    expect(sec10.content).not.toContain('(3) Obtain');
  });

  it('still treats "(n) Whereas" paragraphs before Article 1 as recitals', () => {
    const eu = [
      '(1) Whereas the purpose of this Regulation is to improve the functioning of the internal market.',
      '',
      '(2) Whereas this Regulation should be applied in accordance with the values of the Union.',
      '',
      '(3) Whereas artificial intelligence systems can be easily deployed in a large variety of sectors.',
      '',
      '## Article 1',
      '',
      'Subject matter. (1) The purpose of this Regulation is to lay down harmonised rules.',
      '',
      '## Article 2',
      '',
      'Scope. This Regulation applies to providers placing AI systems on the market.',
    ].join('\n');
    const refs = articleChunk(eu).map((c) => c.articleRef);
    expect(refs).toEqual(expect.arrayContaining(['1', '2', '3', 'Article 1', 'Article 2']));
  });
});
