import { type ComponentRef, type ReactNode, useRef } from 'react';
import { View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useScrollRestoration } from '@oxy.so/bloom/scroll';

interface PageScreenProps {
  title: string;
  /** Show the back capsule (falls back to Home when there is no history). */
  back?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Every Move screen: Bloom's `Screen` + `PageHeader` over one scroll view, with
 * the content in a single readable column (the same on web, iOS and Android).
 * The scroll view keeps its own viewport and binds route restoration through Bloom.
 */
export function PageScreen({ title, back = false, actions, children }: PageScreenProps) {
  const router = useRouter();
  const focused = useIsFocused();
  const scrollRef = useRef<ComponentRef<typeof ScreenScrollView>>(null);
  const restoration = useScrollRestoration(scrollRef);
  const { t } = useTranslation();
  const onBack = back
    ? () => (router.canGoBack() ? router.back() : router.replace('/'))
    : undefined;

  return (
    <Screen
      active={focused}
      header={
        <PageHeader title={title} onBack={onBack} backLabel={t('common.back')} actions={actions} />
      }
    >
      <ScreenScrollView
        ref={scrollRef}
        restoration={restoration}
        keyboardShouldPersistTaps="handled"
      >
        <View className="w-full max-w-xl self-center gap-4 px-4 pb-12 pt-2">{children}</View>
      </ScreenScrollView>
    </Screen>
  );
}
