import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';

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
 */
export function PageScreen({ title, back = false, actions, children }: PageScreenProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const onBack = back
    ? () => (router.canGoBack() ? router.back() : router.replace('/'))
    : undefined;

  return (
    <Screen
      header={
        <PageHeader title={title} onBack={onBack} backLabel={t('common.back')} actions={actions} />
      }
    >
      <ScreenScrollView keyboardShouldPersistTaps="handled">
        <View className="w-full max-w-xl self-center gap-4 px-4 pb-12 pt-2">{children}</View>
      </ScreenScrollView>
    </Screen>
  );
}
