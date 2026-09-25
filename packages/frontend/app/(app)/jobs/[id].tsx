import { useState } from 'react';
import { View } from 'react-native';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useOxy } from '@oxy.so/services';
import { Admonition, AdmonitionButton, AdmonitionContent, AdmonitionIcon, AdmonitionRoot, AdmonitionRow, AdmonitionText } from '@oxy.so/bloom/admonition';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { Meter } from '@oxy.so/bloom/stat-bar';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { MigrationJobView } from '@move/shared-types';
import { MastodonMoveStep } from '@/components/MastodonMoveStep';
import { PageScreen } from '@/components/PageScreen';
import { QueryError } from '@/components/QueryError';
import { JobStatusBadge, PhaseStatusBadge } from '@/components/StatusBadge';
import { MENTION_WEB_URL } from '@/lib/config';
import { formatDateTime, formatNumber } from '@/lib/format';
import { queryKeys, useMoveApi } from '@/lib/moveApiContext';
import type { PlanProgress } from '@/lib/planApplier';
import { isActive, useJob } from '@/lib/useJob';
import { usePlanApplier, type ApplierState } from '@/lib/usePlanApplier';

export default function JobProgressScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const job = useJob(id ?? '');

  return (
    <PageScreen title={t('progress.title')} back>
      {job.isPending ? <Loading accessibilityLabel={t('progress.loading')} /> : null}
      {job.isError ? <QueryError onRetry={() => void job.refetch()} /> : null}
      {job.data ? <JobProgress job={job.data} /> : null}
    </PageScreen>
  );
}

function JobProgress({ job }: { job: MigrationJobView }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const api = useMoveApi();
  const queryClient = useQueryClient();
  const { user } = useOxy();
  const applier = usePlanApplier(job);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const locale = i18n.language;
  const n = (value: number) => formatNumber(value, locale);
  const platformName = t(`platformNames.${job.platform}`);
  const active = isActive(job);
  const c = job.counters;

  const cancel = async () => {
    try {
      const updated = await api.cancel(job.id);
      queryClient.setQueryData(queryKeys.job(job.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
    } catch {
      toast.error(t('common.genericError'));
    }
  };

  return (
    <>
      <Card appearance="outline" radius="radius-16">
        <View className="flex-row items-center gap-3 p-4">
          <Avatar name={platformName} size={44} />
          <View className="flex-1 gap-0.5">
            <Text variant="headline-semibold">{t('progress.from', { platform: platformName })}</Text>
            <Muted numberOfLines={1}>{job.sourceHandle ?? job.sourceActor}</Muted>
          </View>
          <JobStatusBadge status={job.status} />
        </View>
      </Card>

      <StatusNotice job={job} locale={locale} />

      <Card appearance="outline" radius="radius-16">
        <View className="gap-1 p-2" accessibilityRole="list" accessibilityLabel={t('progress.phases')}>
          <Item
            role="listitem"
            title={t('phases.profile')}
            subtitle={profileSubtitle(t, applier.state)}
            trailing={<PhaseStatusBadge status={job.phases.profile.status} />}
          />
          <Item
            role="listitem"
            title={t('phases.graph')}
            subtitle={t('progress.graphCounts', {
              read: n(c.followsRead),
              resolved: n(c.followsResolved),
              followed: n(applierProgress(applier.state)?.followsApplied ?? 0),
            })}
            trailing={<PhaseStatusBadge status={job.phases.graph.status} />}
          />
          <FollowMeter progress={applierProgress(applier.state)} />
          <BlocksRow progress={applierProgress(applier.state)} />
          <Item
            role="listitem"
            title={t('phases.content')}
            subtitle={t('progress.contentCounts', {
              imported: n(c.created + c.existing),
              read: n(c.read),
              skipped: n(c.skipped),
              media: n(c.mediaUploaded),
            })}
            trailing={<PhaseStatusBadge status={job.phases.content.status} />}
          />
          {c.failed > 0 ? (
            <View className="px-3 pb-2">
              <Muted>{t('progress.contentFailed', { count: c.failed })}</Muted>
            </View>
          ) : null}
        </View>
      </Card>

      {applier.state.kind === 'error' ? (
        <AdmonitionRoot type="error">
          <AdmonitionRow>
            <AdmonitionIcon />
            <AdmonitionContent>
              <AdmonitionText>{t('progress.applyFailed')}</AdmonitionText>
              <AdmonitionButton onPress={() => void applier.retry()}>{t('common.retry')}</AdmonitionButton>
            </AdmonitionContent>
          </AdmonitionRow>
        </AdmonitionRoot>
      ) : null}

      {job.platform === 'mastodon' && job.status !== 'undone' && job.status !== 'cancelled' ? (
        <MastodonMoveStep sourceActor={job.sourceActor} ready={job.status === 'done'} />
      ) : null}

      <View className="gap-2">
        {job.status === 'done' && user?.username ? (
          <Button
            tone="action"
            size="lg"
            trailingIcon={RiExternalLinkLine}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(`${MENTION_WEB_URL}/@${user.username}`)}
          >
            {t('progress.viewOnMention')}
          </Button>
        ) : null}
        <Button tone="neutral" appearance="subtle" onPress={() => router.push('/history')}>
          {t('history.title')}
        </Button>
        {active ? (
          <Button tone="danger" appearance="plain" onPress={() => setConfirmCancel(true)} testID="cancel-job">
            {t('progress.cancel')}
          </Button>
        ) : null}
      </View>

      <AlertDialog
        visible={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={t('progress.cancelTitle')}
        description={t('progress.cancelBody')}
        confirmLabel={t('progress.cancel')}
        cancelLabel={t('common.keepGoing')}
        destructive
        onConfirm={() => void cancel()}
      />
    </>
  );
}

function applierProgress(state: ApplierState): PlanProgress | null {
  return state.kind === 'idle' ? null : state.progress;
}

function profileSubtitle(t: TFunction, state: ApplierState): string {
  const progress = applierProgress(state);
  if (progress?.profile === 'applied') return t('progress.profileApplied');
  if (progress?.profile === 'pending') return t('progress.profileApplying');
  return t('progress.profileWaiting');
}

function FollowMeter({ progress }: { progress: PlanProgress | null }) {
  const { t } = useTranslation();
  if (!progress || progress.batchesTotal === 0) return null;
  const valueText = t('progress.batches', { applied: progress.batchesApplied, total: progress.batchesTotal });
  return (
    <View className="gap-1 px-3 pb-2">
      <Meter
        value={progress.batchesApplied}
        max={progress.batchesTotal}
        accessibilityLabel={t('progress.followMeter')}
        valueText={valueText}
      />
      <Muted>{valueText}</Muted>
    </View>
  );
}

function BlocksRow({ progress }: { progress: PlanProgress | null }) {
  const { t } = useTranslation();
  if (!progress || progress.blockBatchesTotal === 0) return null;
  return (
    <Item
      role="listitem"
      title={t('phases.blocks')}
      subtitle={t('progress.blocks', { applied: progress.blocksApplied, total: progress.blocksTotal })}
    />
  );
}

function StatusNotice({ job, locale }: { job: MigrationJobView; locale: string }) {
  const { t } = useTranslation();
  switch (job.status) {
    case 'queued':
      return <Admonition type="info">{t('progress.queued')}</Admonition>;
    case 'paused':
      return (
        <Admonition type="info">
          {t('progress.paused', { until: formatDateTime(job.pausedUntil, locale) ?? t('progress.soon') })}
        </Admonition>
      );
    case 'failed':
      return <Admonition type="error">{t('progress.failed', { error: job.error ?? '' })}</Admonition>;
    case 'done':
      return <Admonition type="tip">{t('progress.done')}</Admonition>;
    case 'cancelled':
      return <Admonition type="info">{t('progress.cancelled')}</Admonition>;
    case 'undone':
      return <Admonition type="info">{t('progress.undone')}</Admonition>;
    default:
      return null;
  }
}
