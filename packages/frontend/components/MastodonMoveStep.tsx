import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { RiExternalLinkLine, RiFileCopyLine } from '@oxy.so/bloom/icons';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { mentionHandle } from '@/lib/connect';
import { mastodonMigrationUrl } from '@/lib/handles';

/**
 * The one step only the user can do: tell Mastodon the account moved, so the
 * instance redirects its followers to the Mention account (which Oxy already
 * lists as an alias, `alsoKnownAs`, of the linked account).
 */
export function MastodonMoveStep({ sourceActor, ready }: { sourceActor: string; ready: boolean }) {
  const { t } = useTranslation();
  const { user } = useOxy();
  const handle = user?.username ? mentionHandle(user.username) : null;
  const migrationUrl = mastodonMigrationUrl(sourceActor);

  const copy = async () => {
    if (!handle) return;
    await Clipboard.setStringAsync(handle);
    toast.success(t('mastodonMove.copied'));
  };

  return (
    <Card appearance="outline" radius="radius-16" testID="mastodon-move-step">
      <CardHeader>
        <CardTitle>{t('mastodonMove.title')}</CardTitle>
        <CardDescription>
          {ready ? t('mastodonMove.body') : t('mastodonMove.notYet')}
        </CardDescription>
      </CardHeader>
      {ready ? (
        <CardBody>
          <View className="gap-3">
            <Text variant="body-regular">{t('mastodonMove.steps')}</Text>
            {handle ? (
              <View className="gap-1">
                <Muted>{t('mastodonMove.targetLabel')}</Muted>
                <Text variant="headline-semibold" selectable testID="mention-handle">
                  {handle}
                </Text>
              </View>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              {handle ? (
                <Button
                  tone="neutral"
                  appearance="subtle"
                  leadingIcon={RiFileCopyLine}
                  onPress={() => void copy()}
                  accessibilityLabel={t('mastodonMove.copyLabel', { handle })}
                >
                  {t('mastodonMove.copy')}
                </Button>
              ) : null}
              {migrationUrl ? (
                <Button
                  tone="action"
                  trailingIcon={RiExternalLinkLine}
                  onPress={() => void Linking.openURL(migrationUrl)}
                  accessibilityRole="link"
                  accessibilityLabel={t('mastodonMove.openLabel')}
                >
                  {t('mastodonMove.open')}
                </Button>
              ) : null}
            </View>
          </View>
        </CardBody>
      ) : null}
    </Card>
  );
}
