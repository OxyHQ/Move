import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { PlatformInfo } from '@move/shared-types';

interface PlatformCardProps {
  platform: PlatformInfo;
  /** Absent: the card only describes (signed out). */
  onConnect?: () => void;
}

/**
 * One source platform: what Move brings from it, and Connect — or "Coming soon".
 * The mark is Bloom's initials disc: Bloom's icon set has no Mastodon, Threads,
 * Instagram, Medium or Substack glyph, and mixing brand glyphs with discs would
 * make the list uneven. Those icons belong in Bloom (docs/follow-ups.md).
 */
export function PlatformCard({ platform, onConnect }: PlatformCardProps) {
  const { t } = useTranslation();
  const available = platform.status === 'available';
  const name = t(`platformNames.${platform.id}`);
  const brings = platform.brings.map((item) => t(`platforms.brings.${item}`)).join(' · ');

  return (
    <Card appearance="outline" radius="radius-16" testID={`platform-${platform.id}`}>
      <View className="flex-row items-center gap-3 p-4">
        <Avatar name={name} size={44} />
        <View className="flex-1 gap-0.5">
          <Text variant="headline-semibold">{name}</Text>
          <Muted numberOfLines={2}>{brings}</Muted>
        </View>
        {available ? (
          onConnect ? (
            <Button
              tone="action"
              size="sm"
              onPress={onConnect}
              accessibilityLabel={t('platforms.connectTo', { name })}
            >
              {t('platforms.connect')}
            </Button>
          ) : null
        ) : (
          <Badge content={t('platforms.soon')} color="default" variant="subtle" size="label-small" />
        )}
      </View>
    </Card>
  );
}
