import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { LinkedAccount } from '@oxy.so/contracts';
import { useOxy } from '@oxy.so/services';
import { Admonition } from '@oxy.so/bloom/admonition';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { TextField, TextFieldHint, TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Lead, Text } from '@oxy.so/bloom/typography';
import { isMigrationPlatform, type MigrationPlatform } from '@move/shared-types';
import { PageScreen } from '@/components/PageScreen';
import { linkAccount, type LinkAttempt } from '@/lib/connect';
import { PLATFORM_NETWORK, linkErrorKey, normalizeSourceInput, startFailureKey } from '@/lib/handles';
import { queryKeys } from '@/lib/moveApiContext';

export default function ConnectScreen() {
  const params = useLocalSearchParams<{ platform: string }>();
  const { t } = useTranslation();

  if (!isMigrationPlatform(params.platform)) {
    return (
      <PageScreen title={t('connect.unknownTitle')} back>
        <EmptyState icon={RiErrorWarningLine} title={t('connect.unknownTitle')} description={t('connect.unknownBody')} />
      </PageScreen>
    );
  }
  return <ConnectPlatform platform={params.platform} />;
}

function ConnectPlatform({ platform }: { platform: MigrationPlatform }) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { oxyServices } = useOxy();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<LinkedAccount | null>(null);
  const name = t(`platformNames.${platform}`);

  const linked = useQuery({
    queryKey: queryKeys.linkedAccounts,
    queryFn: () => oxyServices.listLinkedAccounts(),
  });
  const accounts = (linked.data ?? []).filter((account) => account.network === PLATFORM_NETWORK[platform]);
  const normalized = normalizeSourceInput(platform, input);
  const invalid = input.trim().length > 0 && normalized === null;

  const goToConfirm = (linkedAccountId: string) =>
    router.push({ pathname: '/confirm', params: { platform, linkedAccountId } });

  const onOutcome = (outcome: LinkAttempt) => {
    if (outcome.kind === 'linked') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.linkedAccounts });
      goToConfirm(outcome.linkedAccountId);
    } else if (outcome.kind === 'error') {
      setProblem(t(linkErrorKey(outcome.code)));
    }
  };

  const connect = async () => {
    if (!normalized) return;
    setBusy(true);
    setProblem(null);
    try {
      onOutcome(await linkAccount(oxyServices, platform, normalized));
    } catch (error) {
      // Oxy refused to start; its `details.reason` says whether the input or
      // the other network is at fault.
      setProblem(t(startFailureKey(platform, error), { name }));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (account: LinkedAccount) => {
    try {
      await oxyServices.revokeLinkedAccount(account.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.linkedAccounts });
      toast.success(t('connect.unlinked', { handle: account.handle }));
    } catch {
      toast.error(t('common.genericError'));
    }
  };

  return (
    <PageScreen title={t('connect.title', { name })} back>
      <Lead>{t(`connect.intro.${platform}`)}</Lead>

      {accounts.length > 0 ? (
        <Card appearance="outline" radius="radius-16">
          <View className="gap-1 p-2">
            <View className="px-2 pt-1">
              <Text variant="caption-1-semibold">{t('connect.alreadyConnected')}</Text>
            </View>
            {accounts.map((account) => (
              <Item
                key={account.id}
                role="listitem"
                title={account.handle}
                subtitle={account.host}
                trailing={
                  <View className="flex-row gap-2">
                    <Button
                      tone="neutral"
                      appearance="subtle"
                      size="sm"
                      onPress={() => setUnlinking(account)}
                      accessibilityLabel={t('connect.unlinkAccount', { handle: account.handle })}
                    >
                      {t('connect.unlink')}
                    </Button>
                    <Button
                      tone="action"
                      size="sm"
                      onPress={() => goToConfirm(account.id)}
                      accessibilityLabel={t('connect.useAccount', { handle: account.handle })}
                    >
                      {t('connect.use')}
                    </Button>
                  </View>
                }
              />
            ))}
          </View>
        </Card>
      ) : null}
      {linked.isPending ? <Loading variant="inline" text={t('connect.loadingAccounts')} /> : null}

      <View className="gap-2">
        <TextField invalid={invalid}>
          <TextFieldInput
            label={t(`connect.inputLabel.${platform}`)}
            placeholder={t(`connect.inputPlaceholder.${platform}`)}
            value={input}
            onValueChange={setInput}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            keyboardType={platform === 'mastodon' ? 'email-address' : 'default'}
            returnKeyType="go"
            onSubmitEditing={() => void connect()}
            testID="connect-input"
          />
        </TextField>
        <TextFieldHint invalid={invalid}>
          {invalid ? t(`connect.inputInvalid.${platform}`) : t(`connect.inputHint.${platform}`)}
        </TextFieldHint>
      </View>

      {problem ? <Admonition type="error">{problem}</Admonition> : null}

      <Button
        tone="action"
        size="lg"
        loading={busy}
        disabled={!normalized || busy}
        onPress={() => void connect()}
        testID="connect-submit"
      >
        {t('connect.submit', { name })}
      </Button>
      <Lead>{t('connect.privacy', { name })}</Lead>

      <AlertDialog
        visible={unlinking !== null}
        onClose={() => setUnlinking(null)}
        title={t('connect.unlinkTitle', { handle: unlinking?.handle ?? '' })}
        description={t('connect.unlinkBody')}
        confirmLabel={t('connect.unlink')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={() => {
          if (unlinking) void unlink(unlinking);
        }}
      />
    </PageScreen>
  );
}
