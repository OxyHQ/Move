import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { OxySignInButton, useOxy } from '@oxy.so/services';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCheckboxCircleLine, RiErrorWarningLine } from '@oxy.so/bloom/icons';
import { Loading } from '@oxy.so/bloom/loading';
import { PageScreen } from '@/components/PageScreen';
import { linkErrorKey, outcomeFromParams, platformForNetwork } from '@/lib/handles';
import { linkedAccounts } from '@/lib/linkedAccounts';
import { queryKeys } from '@/lib/moveApiContext';

/**
 * Where Oxy's linked-account callback lands: `?linked=<id>` or `?link_error=<code>`.
 * Normally the auth session consumes this URL (the web popup is closed by
 * `maybeCompleteAuthSession`, native returns it to `openAuthSessionAsync`);
 * this screen is for when the browser landed here on its own — a blocked
 * popup, or the app opened fresh from the return link.
 */
export default function LinkedScreen() {
  const params = useLocalSearchParams<{ linked?: string; link_error?: string }>();
  const outcome = outcomeFromParams(params);
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated, isAuthResolved, oxyServices } = useOxy();
  const linkedAccountId = outcome?.kind === 'linked' ? outcome.linkedAccountId : null;

  const accounts = useQuery({
    queryKey: queryKeys.linkedAccounts,
    queryFn: () => linkedAccounts(oxyServices).listLinkedAccounts(),
    enabled: isAuthenticated && linkedAccountId !== null,
  });
  const account = accounts.data?.find((candidate) => candidate.id === linkedAccountId);

  const body = (() => {
    if (!outcome || outcome.kind === 'cancelled') {
      return (
        <EmptyState
          icon={RiErrorWarningLine}
          title={t('linked.nothingTitle')}
          description={t('linked.nothingBody')}
          action={{ label: t('linked.home'), onPress: () => router.replace('/') }}
        />
      );
    }
    if (outcome.kind === 'error') {
      return (
        <EmptyState
          icon={RiErrorWarningLine}
          title={t('linked.errorTitle')}
          description={t(linkErrorKey(outcome.code))}
          action={{ label: t('linked.tryAgain'), onPress: () => router.replace('/') }}
        />
      );
    }
    if (!isAuthResolved) return <Loading accessibilityLabel={t('common.loading')} />;
    if (!isAuthenticated) {
      return (
        <EmptyState
          icon={RiCheckboxCircleLine}
          title={t('linked.successTitle')}
          description={t('linked.signInToContinue')}
          footer={<OxySignInButton variant="contained" />}
        />
      );
    }
    if (accounts.isPending) return <Loading accessibilityLabel={t('common.loading')} />;
    return (
      <EmptyState
        icon={RiCheckboxCircleLine}
        media="circle"
        title={t('linked.successTitle')}
        description={account ? t('linked.successBody', { handle: account.handle }) : t('linked.successBodyGeneric')}
        action={
          account
            ? {
                label: t('linked.continue'),
                onPress: () =>
                  router.replace({
                    pathname: '/confirm',
                    params: { platform: platformForNetwork(account.network), linkedAccountId: account.id },
                  }),
              }
            : { label: t('linked.home'), onPress: () => router.replace('/') }
        }
      />
    );
  })();

  return <PageScreen title={t('linked.title')}>{body}</PageScreen>;
}
