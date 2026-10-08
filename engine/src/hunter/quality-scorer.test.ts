// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * scoreDocumentQuality on real-shaped documents (every pipeline test mocks it).
 *
 * End-to-end audit: a clean upload of the Illinois AI Video Interview Act
 * (820 ILCS 42) scored grade D — its ordinary vocabulary was missing from the
 * ~500-word dictionary — so the pipeline rejected it and "healed" the upload
 * by fetching the live URL instead.
 */
import { describe, it, expect } from 'vitest';
import { scoreDocumentQuality } from './quality-scorer.js';

const ILCS = `# (820 ILCS 42/) Artificial Intelligence Video Interview Act.

## (820 ILCS 42/5) Sec. 5. Disclosure of the use of artificial intelligence analysis.

An employer that asks applicants to record video interviews and uses an artificial intelligence analysis of the applicant-submitted videos shall do all of the following when considering applicants for positions based in Illinois before asking applicants to submit video interviews:

(1) Notify each applicant before the interview that artificial intelligence may be used to analyze the applicant's video interview and consider the applicant's fitness for the position.

(2) Provide each applicant with information before the interview explaining how the artificial intelligence works and what general types of characteristics it uses to evaluate applicants.

(3) Obtain, before the interview, consent from the applicant to be evaluated by the artificial intelligence program as described in the information provided.

An employer may not use artificial intelligence to evaluate applicants who have not consented to the use of artificial intelligence analysis.

## (820 ILCS 42/10) Sec. 10. Sharing videos limited.

An employer may not share applicant videos, except with persons whose expertise or technology is necessary in order to evaluate an applicant's fitness for a position.

## (820 ILCS 42/15) Sec. 15. Destruction of videos.

Upon request from the applicant, employers, within 30 days after receipt of the request, must delete an applicant's interviews and instruct any other persons who received copies of the applicant video interviews to also delete the videos, including any electronically generated backup copies.

## (820 ILCS 42/20) Sec. 20. Report of demographic data.

(a) An employer that relies solely upon an artificial intelligence analysis of a video interview to determine whether an applicant will be selected for an in-person interview must collect and report the race and ethnicity of applicants who are and are not afforded the opportunity for an in-person interview.
`;

describe('scoreDocumentQuality', () => {
  it('passes a clean US statute (grade A or B)', () => {
    const q = scoreDocumentQuality(ILCS);
    expect(['A', 'B']).toContain(q.overallGrade);
    expect(q.textScore).toBeGreaterThan(0.9);
  });

  it('passes clean legal text in another language', () => {
    const lgpd = Array.from({ length: 12 }, () =>
      'Art. 6º As atividades de tratamento de dados pessoais deverão observar a boa-fé e os seguintes princípios: finalidade, adequação, necessidade, livre acesso, qualidade dos dados, transparência, segurança, prevenção, não discriminação, responsabilização e prestação de contas.',
    ).join('\n\n');
    expect(scoreDocumentQuality(`# Lei Geral de Proteção de Dados\n\n${lgpd}`).textScore).toBeGreaterThan(0.85);
  });

  it('still fails binary/encoded garbage', () => {
    const garbage = Array.from({ length: 300 }, (_, i) =>
      `x${i}#@!k ${Buffer.from(`blob-${i}-payload-data-${i * 7}`).toString('base64')} %$^&*${i}`,
    ).join(' ');
    expect(['D', 'F']).toContain(scoreDocumentQuality(garbage).overallGrade);
  });

  it('still fails text that is too short to analyse', () => {
    expect(scoreDocumentQuality('Sec. 1. Short title.').overallGrade).toBe('F');
  });
});
