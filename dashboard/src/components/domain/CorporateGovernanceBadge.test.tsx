import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CorporateGovernanceBadge from './CorporateGovernanceBadge';

describe('CorporateGovernanceBadge (Attestations list)', () => {
  it('shows the exception count, with every manifest count on hover', () => {
    const html = renderToStaticMarkup(<CorporateGovernanceBadge governance={{ exceptions: 2, caseClosures: 1, ciRuns: 3 }} />);
    expect(html).toContain('>Corporate governance: 2 exceptions<');
    expect(html).toContain('title="Signed corporate-governance manifest: 2 exceptions, 1 case closure, 3 CI runs"');
  });

  it('uses the singular for one and shows zero counts (a manifest with no exceptions)', () => {
    expect(renderToStaticMarkup(<CorporateGovernanceBadge governance={{ exceptions: 1, caseClosures: 0, ciRuns: 1 }} />))
      .toContain('Corporate governance: 1 exception<');
    const zero = renderToStaticMarkup(<CorporateGovernanceBadge governance={{ exceptions: 0, caseClosures: 0, ciRuns: 0 }} />);
    expect(zero).toContain('Corporate governance: 0 exceptions');
    expect(zero).toContain('0 case closures, 0 CI runs');
  });

  it('renders nothing for an attestation without a corporate-governance manifest', () => {
    expect(renderToStaticMarkup(<CorporateGovernanceBadge governance={undefined} />)).toBe('');
  });
});
