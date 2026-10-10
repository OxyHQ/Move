import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons';
import { Loading } from '@oxy.so/bloom/loading';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { Muted, Text } from '@oxy.so/bloom/typography';
import {
  DEFAULT_JOB_OPTIONS,
  isMigrationPlatform,
  type MigrationPlatform,
  type MigrationPreview,
} from '@move/shared-types';
import { PageScreen } from '@/components/PageScreen';
import { QueryError } from '@/components/QueryError';
import { formatDate, formatNumber } from '@/lib/format';
import { errorCode } from '@/lib/moveApi';
import { queryKeys, useMoveApi } from '@/lib/moveApiContext';

const KNOWN_ERRORS = [
  'linked_account_not_owned',
  'source_requires_authorized_fetch',
  'source_unavailable',
  'active_job_exists',
];

function errorMessageKey(error: unknown): string {
  const code = errorCode(error);
  return code && KNOWN_ERRORS.includes(code) ? `jobErrors.${code}` : 'common.genericError';
}

export default function ConfirmScreen() {
  const params = useLocalSearchParams<{ platform: string; linkedAccountId: string }>();
  const { t } = useTranslation();
  const { platform, linkedAccountId } = params;

  if (!isMigrationPlatform(platform) || !linkedAccountId) {
    return (
      <PageScreen title={t('confirm.title')} back>
        <EmptyState
          icon={RiErrorWarningLine}
          title={t('connect.unknownTitle')}
          description={t('connect.unknownBody')}
        />
      </PageScreen>
    );
  }
  return <ConfirmMove platform={platform} linkedAccountId={linkedAccountId} />;
}

function ConfirmMove({
  platform,
  linkedAccountId,
}: {
  platform: MigrationPlatform;
  linkedAccountId: string;
}) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const api = useMoveApi();
  const queryClient = useQueryClient();
  const [includeBoosts, setIncludeBoosts] = useState(DEFAULT_JOB_OPTIONS.includeBoosts);
  const [includeReplies, setIncludeReplies] = useState(DEFAULT_JOB_OPTIONS.includeRepliesToOthers);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: queryKeys.preview(platform, linkedAccountId),
    queryFn: () => api.preview(platform, linkedAccountId),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const job = await api.create(platform, linkedAccountId, {
        includeBoosts,
        includeRepliesToOthers: includeReplies,
      });
      queryClient.setQueryData(queryKeys.job(job.id), job);
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      router.replace({ pathname: '/jobs/[id]', params: { id: job.id } });
    } catch (error) {
      setStartError(t(errorMessageKey(error)));
    } finally {
      setStarting(false);
    }
  };

  return (
    <PageScreen title={t('confirm.title')} back>
      {preview.isPending ? (
        <Loading accessibilityLabel={t('confirm.loading')} text={t('confirm.loading')} />
      ) : null}
      {preview.isError ? (
        <QueryError
          message={t(errorMessageKey(preview.error))}
          onRetry={() => void preview.refetch()}
        />
      ) : null}
      {preview.data ? (
        <>
          <PreviewSummary preview={preview.data} locale={i18n.language} />

          <SettingsListGroup title={t('confirm.options')}>
            <SettingsListItem
              title={t('confirm.includeBoosts')}
              description={t('confirm.includeBoostsHint')}
              rightElement={
                <Switch
                  checked={includeBoosts}
                  onCheckedChange={setIncludeBoosts}
                  accessibilityLabel={t('confirm.includeBoosts')}
                  testID="toggle-boosts"
                />
              }
            />
            <SettingsListItem
              title={t('confirm.includeReplies')}
              description={t('confirm.includeRepliesHint')}
              rightElement={
                <Switch
                  checked={includeReplies}
                  onCheckedChange={setIncludeReplies}
                  accessibilityLabel={t('confirm.includeReplies')}
                  testID="toggle-replies"
                />
              }
            />
          </SettingsListGroup>

          {startError ? <Admonition type="error">{startError}</Admonition> : null}

          <Button
            tone="action"
            size="lg"
            loading={starting}
            onPress={() => void start()}
            testID="move-submit"
          >
            {t('confirm.submit')}
          </Button>
          <Muted>{t('confirm.undoNote')}</Muted>
        </>
      ) : null}
    </PageScreen>
  );
}

function PreviewSummary({ preview, locale }: { preview: MigrationPreview; locale: string }) {
  const { t } = useTranslation();
  const name = preview.profile.displayName || preview.handle;
  const oldest = formatDate(preview.oldestAt, locale);
  const newest = formatDate(preview.newestAt, locale);
  const posts = preview.counts.posts;
  const following = preview.counts.following;

  return (
    <>
      <Card appearance="outline" radius="radius-16">
        <View className="flex-row items-center gap-3 p-4">
          <Avatar source={preview.profile.avatarUrl ?? null} name={name} size={56} />
          <View className="flex-1 gap-0.5">
            <Text variant="headline-semibold" numberOfLines={1}>
              {name}
            </Text>
            <Muted numberOfLines={1}>{preview.handle}</Muted>
          </View>
        </View>
        {preview.profile.bio ? (
          <View className="px-4 pb-4">
            <Text variant="body-regular">{preview.profile.bio}</Text>
          </View>
        ) : null}
      </Card>

      <SettingsListGroup title={t('confirm.whatMoves')}>
        <SettingsListItem
          title={t('confirm.profile')}
          description={t('confirm.profileHint')}
          showChevron={false}
          value="✓"
        />
        <SettingsListItem
          title={
            posts !== undefined
              ? t('confirm.posts', { count: posts, formatted: formatNumber(posts, locale) })
              : t('confirm.postsUnknown')
          }
          description={
            oldest && newest ? t('confirm.dateRange', { oldest, newest }) : t('confirm.postsHint')
          }
          showChevron={false}
          value="✓"
        />
        <SettingsListItem
          title={
            preview.graphHidden
              ? t('confirm.followingHidden')
              : following !== undefined
                ? t('confirm.following', {
                    count: following,
                    formatted: formatNumber(following, locale),
                  })
                : t('confirm.followingUnknown')
          }
          description={t('confirm.followingHint')}
          showChevron={false}
          value={preview.graphHidden ? '—' : '✓'}
        />
        {preview.platform === 'bluesky' ? (
          <SettingsListItem
            title={t('confirm.blocks')}
            description={t('confirm.blocksHint')}
            showChevron={false}
            value="✓"
          />
        ) : null}
        {preview.platform === 'mastodon' ? (
          <SettingsListItem
            title={t('confirm.followers')}
            description={t('confirm.followersHint')}
            showChevron={false}
            value="✓"
          />
        ) : null}
      </SettingsListGroup>
    </>
  );
}
