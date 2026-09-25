import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { Card } from '@oxy.so/bloom/card';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { RiHistoryLine, RiLogoutBoxRLine } from '@oxy.so/bloom/icons';
import { H1, Lead, Text } from '@oxy.so/bloom/typography';
import { isMigrationPlatform } from '@move/shared-types';
import { PageScreen } from '@/components/PageScreen';
import { PlatformCard } from '@/components/PlatformCard';
import { QueryError } from '@/components/QueryError';
import { queryKeys, useMoveApi } from '@/lib/moveApiContext';
import { isActive } from '@/lib/useJob';

export default function HomeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { logout } = useOxy();
  const api = useMoveApi();
  const platforms = useQuery({ queryKey: queryKeys.platforms, queryFn: () => api.platforms() });
  const jobs = useQuery({ queryKey: queryKeys.jobs, queryFn: () => api.list() });
  const activeJobs = (jobs.data ?? []).filter(isActive);

  return (
    <PageScreen
      title={t('app.name')}
      actions={
        <ButtonGroup accessibilityLabel={t('home.actions')}>
          <ButtonGroupItem
            iconOnly
            leadingIcon={RiHistoryLine}
            accessibilityLabel={t('history.title')}
            onPress={() => router.push('/history')}
          />
          <ButtonGroupItem
            iconOnly
            leadingIcon={RiLogoutBoxRLine}
            accessibilityLabel={t('home.signOut')}
            onPress={() => void logout()}
          />
        </ButtonGroup>
      }
    >
      <View className="gap-2 pt-4">
        <H1>{t('home.title')}</H1>
        <Lead>{t('home.subtitle')}</Lead>
      </View>

      {activeJobs.length > 0 ? (
        <Card appearance="subtle" radius="radius-16">
          <View className="gap-1 p-2">
            <View className="px-2 pt-1">
              <Text variant="caption-1-semibold">{t('home.inProgress')}</Text>
            </View>
            {activeJobs.map((job) => (
              <Item
                key={job.id}
                role="listitem"
                title={t(`platformNames.${job.platform}`)}
                subtitle={job.sourceHandle ?? job.sourceActor}
                trailing={<Loading variant="inline" size="sm" />}
                onPress={() => router.push({ pathname: '/jobs/[id]', params: { id: job.id } })}
                accessibilityLabel={t('home.openProgress', { platform: t(`platformNames.${job.platform}`) })}
              />
            ))}
          </View>
        </Card>
      ) : null}

      {platforms.isPending ? <Loading accessibilityLabel={t('home.loadingPlatforms')} /> : null}
      {platforms.isError ? <QueryError onRetry={() => void platforms.refetch()} /> : null}
      {platforms.data?.map((platform) => (
        <PlatformCard
          key={platform.id}
          platform={platform}
          onConnect={
            isMigrationPlatform(platform.id)
              ? () => router.push({ pathname: '/connect/[platform]', params: { platform: platform.id } })
              : undefined
          }
        />
      ))}
    </PageScreen>
  );
}
