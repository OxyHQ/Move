import { useState } from 'react';
import { View } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiExternalLinkLine, RiHistoryLine } from '@oxy.so/bloom/icons';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { MigrationJobView } from '@move/shared-types';
import { PageScreen } from '@/components/PageScreen';
import { QueryError } from '@/components/QueryError';
import { JobStatusBadge } from '@/components/StatusBadge';
import { MENTION_WEB_URL } from '@/lib/config';
import { formatDate, formatNumber } from '@/lib/format';
import { queryKeys, useMoveApi } from '@/lib/moveApiContext';
import { undoPlan } from '@/lib/planApplier';
import { usePlanDeps } from '@/lib/usePlanApplier';

export default function HistoryScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const api = useMoveApi();
  const jobs = useQuery({ queryKey: queryKeys.jobs, queryFn: () => api.list() });

  return (
    <PageScreen title={t('history.title')} back>
      {jobs.isPending ? <Loading accessibilityLabel={t('history.loading')} /> : null}
      {jobs.isError ? <QueryError onRetry={() => void jobs.refetch()} /> : null}
      {jobs.data && jobs.data.length === 0 ? (
        <EmptyState
          icon={RiHistoryLine}
          title={t('history.emptyTitle')}
          description={t('history.emptyBody')}
          action={{ label: t('history.start'), onPress: () => router.replace('/') }}
        />
      ) : null}
      {jobs.data?.map((job) => (
        <HistoryEntry key={job.id} job={job} />
      ))}
    </PageScreen>
  );
}

function canUndo(job: MigrationJobView): boolean {
  return job.status !== 'undone' || (job.undo?.failed ?? 0) > 0;
}

function HistoryEntry({ job }: { job: MigrationJobView }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const api = useMoveApi();
  const deps = usePlanDeps();
  const queryClient = useQueryClient();
  const { user } = useOxy();
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const platformName = t(`platformNames.${job.platform}`);
  const imported = job.counters.created + job.counters.existing;

  const undo = async () => {
    setUndoing(true);
    try {
      // The backend stops the job and deletes the imported posts from Mention,
      // then hands back the plan, the ack and the recorded undo facts; only this
      // session can reverse the profile, follows and blocks — on any device.
      const result = await api.undo(job.id);
      const client = await undoPlan(deps, result);
      queryClient.setQueryData(queryKeys.job(job.id), result.job);
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      if (result.failed > 0) {
        toast.warning(t('history.undoPartial', { count: result.failed }));
      } else {
        toast.success(
          t('history.undone', {
            posts: result.deleted,
            follows: client.unfollowed,
            blocks: client.unblocked,
          }),
        );
      }
      if (client.profileKept) {
        toast.info(t('history.undoKept'));
      }
    } catch {
      toast.error(t('history.undoFailed'));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <Card appearance="outline" radius="radius-16" testID={`history-${job.id}`}>
      <View className="gap-3 p-4">
        <View className="flex-row items-center gap-3">
          <Avatar name={platformName} size={40} />
          <View className="flex-1 gap-0.5">
            <Text variant="headline-semibold" numberOfLines={1}>
              {job.sourceHandle ?? platformName}
            </Text>
            <Muted>
              {t('history.startedOn', { date: formatDate(job.createdAt, i18n.language) ?? '' })}
            </Muted>
          </View>
          <JobStatusBadge status={job.status} />
        </View>
        <Muted>
          {t('history.summary', {
            posts: formatNumber(imported, i18n.language),
            follows: formatNumber(job.counters.followsResolved, i18n.language),
          })}
        </Muted>
        <View className="flex-row flex-wrap gap-2">
          <Button
            tone="neutral"
            appearance="subtle"
            size="sm"
            onPress={() => router.push({ pathname: '/jobs/[id]', params: { id: job.id } })}
          >
            {t('history.details')}
          </Button>
          {user?.username && imported > 0 && job.status !== 'undone' ? (
            <Button
              tone="neutral"
              appearance="subtle"
              size="sm"
              trailingIcon={RiExternalLinkLine}
              accessibilityRole="link"
              onPress={() => void Linking.openURL(`${MENTION_WEB_URL}/@${user.username}`)}
            >
              {t('history.viewOnMention')}
            </Button>
          ) : null}
          {canUndo(job) ? (
            <Button
              tone="danger"
              appearance="subtle"
              size="sm"
              loading={undoing}
              onPress={() => setConfirming(true)}
              accessibilityLabel={t('history.undoLabel', { platform: platformName })}
              testID={`undo-${job.id}`}
            >
              {job.status === 'undone' ? t('history.retryUndo') : t('history.undo')}
            </Button>
          ) : null}
        </View>
      </View>
      <AlertDialog
        visible={confirming}
        onClose={() => setConfirming(false)}
        title={t('history.undoTitle', { platform: platformName })}
        description={t('history.undoBody')}
        confirmLabel={t('history.undo')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={() => void undo()}
      />
    </Card>
  );
}
