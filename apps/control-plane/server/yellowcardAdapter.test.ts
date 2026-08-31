import { describe, expect, it } from 'vitest';
import { normalizeYellowCardStatus } from './yellowcardAdapter';

describe('Yellow Card adapter normalization', () => {
  it('maps complete to settled without retry permission', () => {
    expect(normalizeYellowCardStatus('ref', 'seq', 'complete')).toMatchObject({ status: 'settled', retryableWithoutBusinessEffect: false });
  });

  it('maps expired to safe non-submission', () => {
    expect(normalizeYellowCardStatus('ref', 'seq', 'expired')).toMatchObject({ status: 'failed', retryableWithoutBusinessEffect: true });
  });

  it('keeps generic failures unknown', () => {
    expect(normalizeYellowCardStatus('ref', 'seq', 'failed')).toMatchObject({ status: 'unknown', retryableWithoutBusinessEffect: false });
  });

  it('keeps unrecognized provider states unknown', () => {
    expect(normalizeYellowCardStatus('ref', 'seq', 'new_state')).toMatchObject({ status: 'unknown', retryableWithoutBusinessEffect: false });
  });
});
