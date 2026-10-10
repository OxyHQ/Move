import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import type { Props as IconProps } from '@oxy.so/bloom/icons';
import { RiBlueskyFill } from '@oxy.so/bloom/icons/RiBlueskyFill';
import { RiInstagramFill } from '@oxy.so/bloom/icons/RiInstagramFill';
import { RiMastodonFill } from '@oxy.so/bloom/icons/RiMastodonFill';
import { RiMediumFill } from '@oxy.so/bloom/icons/RiMediumFill';
import { RiThreadsFill } from '@oxy.so/bloom/icons/RiThreadsFill';
import { RiTwitterXFill } from '@oxy.so/bloom/icons/RiTwitterXFill';
import { SiSubstack } from '@oxy.so/bloom/icons/SiSubstack';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { ComponentType } from 'react';
import type { PlatformInfo } from '@move/shared-types';

/** Each platform's mark, from Bloom's icon set. Exhaustive over the platform ids. */
const PLATFORM_ICONS: Record<PlatformInfo['id'], ComponentType<IconProps>> = {
  mastodon: RiMastodonFill,
  bluesky: RiBlueskyFill,
  threads: RiThreadsFill,
  instagram: RiInstagramFill,
  x: RiTwitterXFill,
  medium: RiMediumFill,
  substack: SiSubstack,
};

interface PlatformCardProps {
  platform: PlatformInfo;
  /** Absent: the card only describes (signed out). */
  onConnect?: () => void;
}

/**
 * One source platform: its mark, what Move brings from it, and Connect — or
 * "Coming soon". The mark is the platform's brand glyph on Bloom's tinted disc,
 * in the theme's colours rather than the brand's.
 */
export function PlatformCard({ platform, onConnect }: PlatformCardProps) {
  const { t } = useTranslation();
  const available = platform.status === 'available';
  const name = t(`platformNames.${platform.id}`);
  const brings = platform.brings.map((item) => t(`platforms.brings.${item}`)).join(' · ');

  return (
    <Card appearance="outline" radius="radius-16" testID={`platform-${platform.id}`}>
      <View className="flex-row items-center gap-3 p-4">
        <IconCircle icon={PLATFORM_ICONS[platform.id]} size="lg" />
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
          <Badge
            content={t('platforms.soon')}
            color="default"
            variant="subtle"
            size="label-small"
          />
        )}
      </View>
    </Card>
  );
}
