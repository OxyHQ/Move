import { useTranslation } from 'react-i18next';
import { Badge } from '@oxy.so/bloom/badge';
import type { JobStatus, PhaseStatus } from '@move/shared-types';

type Tone = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';

const JOB_TONE: Record<JobStatus, Tone> = {
  queued: 'default',
  running: 'primary',
  paused: 'warning',
  done: 'success',
  failed: 'error',
  cancelled: 'default',
  undone: 'default',
};

const PHASE_TONE: Record<PhaseStatus, Tone> = {
  pending: 'default',
  running: 'primary',
  done: 'success',
  skipped: 'default',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const { t } = useTranslation();
  return (
    <Badge
      content={t(`status.${status}`)}
      color={JOB_TONE[status]}
      variant="subtle"
      size="label-small"
    />
  );
}

export function PhaseStatusBadge({ status }: { status: PhaseStatus }) {
  const { t } = useTranslation();
  return (
    <Badge
      content={t(`phaseStatus.${status}`)}
      color={PHASE_TONE[status]}
      variant="subtle"
      size="label-small"
    />
  );
}
