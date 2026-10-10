import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { OxySignInButton } from '@oxy.so/services';
import { Loading } from '@oxy.so/bloom/loading';
import { H1, Lead } from '@oxy.so/bloom/typography';
import { PageScreen } from '@/components/PageScreen';
import { PlatformCard } from '@/components/PlatformCard';
import { QueryError } from '@/components/QueryError';
import { queryKeys, useMoveApi } from '@/lib/moveApiContext';

/** Signed out: what Move does, the platforms (public), and the Oxy sign-in. */
export default function SignedOutHomeScreen() {
  const { t } = useTranslation();
  const api = useMoveApi();
  const platforms = useQuery({ queryKey: queryKeys.platforms, queryFn: () => api.platforms() });

  return (
    <PageScreen title={t('app.name')}>
      <View className="gap-2 pt-4">
        <H1>{t('home.title')}</H1>
        <Lead>{t('home.subtitle')}</Lead>
      </View>
      <View className="items-center gap-2 py-2">
        {/* The in-app OxyAccountDialog — never a redirect to an external IdP. */}
        <OxySignInButton variant="contained" />
        <Lead>{t('auth.subtitle')}</Lead>
      </View>
      {platforms.isPending ? <Loading accessibilityLabel={t('home.loadingPlatforms')} /> : null}
      {platforms.isError ? <QueryError onRetry={() => void platforms.refetch()} /> : null}
      {platforms.data?.map((platform) => (
        <PlatformCard key={platform.id} platform={platform} />
      ))}
    </PageScreen>
  );
}
