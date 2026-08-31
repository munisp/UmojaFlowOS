export type NormalizedStatus = 'submitted' | 'pending' | 'settled' | 'failed' | 'unknown';

export type YellowCardResult = {
  reference: string;
  sequenceId: string;
  status: NormalizedStatus;
  retryableWithoutBusinessEffect: boolean;
  reason: string;
};

export function normalizeYellowCardStatus(reference: string, sequenceId: string, rawStatus: string): YellowCardResult {
  const value = rawStatus.trim().toLowerCase();
  if (['complete', 'completed', 'settled', 'success', 'successful'].includes(value)) {
    return { reference, sequenceId, status: 'settled', retryableWithoutBusinessEffect: false, reason: 'Yellow Card independently reported a completed send' };
  }
  if (['created', 'accepted', 'processing', 'pending', 'in_progress', 'awaiting_approval'].includes(value)) {
    return { reference, sequenceId, status: 'pending', retryableWithoutBusinessEffect: false, reason: 'Yellow Card send remains provisional' };
  }
  if (['expired', 'cancelled', 'canceled', 'rejected'].includes(value)) {
    return { reference, sequenceId, status: 'failed', retryableWithoutBusinessEffect: true, reason: 'Yellow Card explicitly reported a non-executed send' };
  }
  return { reference, sequenceId, status: 'unknown', retryableWithoutBusinessEffect: false, reason: 'Yellow Card status is not safe to classify' };
}
