import { useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { OxySignInButton, useOxy } from '@oxy.so/services';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCheckboxCircleLine, RiErrorWarningLine } from '@oxy.so/bloom/icons';
import { Loading } from '@oxy.so/bloom/loading';
import { PageScreen } from '@/components/PageScreen';
import { completeLink, linkErrorKey, outcomeFromParams, platformForNetwork, type LinkResult } from '@/lib/handles';
import { queryKeys } from '@/lib/moveApiContext';

/**
 * Where Oxy's linked-account callback lands: `?link_code=<code>` or `?link_error=<code>`.
 * Normally the auth session consumes this URL (the web popup is closed by
 * `maybeCompleteAuthSession`, native returns it to `openAuthSessionAsync`);
 * this screen is for when the browser landed here on its own — a blocked
 * popup, or the app opened fresh from the return link. It completes the code
 * once the user is signed in (the same user who started the flow).
 */
export default function LinkedScreen() {
  const params = useLocalSearchParams<{ link_code?: string; link_error?: string }>();
  const outcome = outcomeFromParams(params);
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated, isAuthResolved, oxyServices } = useOxy();
  const code = outcome?.kind === 'code' ? outcome.code : null;
  const [result, setResult] = useState<LinkResult | null>(null);
  // The code is one-time: complete it exactly once, whatever re-runs the effect
  // (StrictMode's double mount, auth state settling).
  const completing = useRef<string | null>(null);

  useEffect(() => {
    if (!code || !isAuthenticated || completing.current === code) return;
    completing.current = code;
    void completeLink(oxyServices, code).then(async (completed) => {
      if (completed.kind === 'linked') await queryClient.invalidateQueries({ queryKey: queryKeys.linkedAccounts });
      setResult(completed);
    });
  }, [code, isAuthenticated, oxyServices, queryClient]);

  const linkedAccountId = result?.kind === 'linked' ? result.linkedAccountId : null;

  const accounts = useQuery({
    queryKey: queryKeys.linkedAccounts,
    queryFn: () => oxyServices.linkedAccounts.list(),
    enabled: isAuthenticated && linkedAccountId !== null,
  });
  const account = accounts.data?.find((candidate) => candidate.id === linkedAccountId);

  const body = (() => {
    if (!outcome) {
      return (
        <EmptyState
          icon={RiErrorWarningLine}
          title={t('linked.nothingTitle')}
          description={t('linked.nothingBody')}
          action={{ label: t('linked.home'), onPress: () => router.replace('/') }}
        />
      );
    }
    const failed = outcome.kind === 'error' ? outcome : result?.kind === 'error' ? result : null;
    if (failed) {
      return (
        <EmptyState
          icon={RiErrorWarningLine}
          title={t('linked.errorTitle')}
          description={t(linkErrorKey(failed.code))}
          action={{ label: t('linked.tryAgain'), onPress: () => router.replace('/') }}
        />
      );
    }
    if (!isAuthResolved) return <Loading accessibilityLabel={t('common.loading')} />;
    if (!isAuthenticated) {
      return (
        <EmptyState
          icon={RiCheckboxCircleLine}
          title={t('linked.signInTitle')}
          description={t('linked.signInToContinue')}
          footer={<OxySignInButton variant="contained" />}
        />
      );
    }
    if (!result || accounts.isPending) return <Loading accessibilityLabel={t('common.loading')} />;
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
