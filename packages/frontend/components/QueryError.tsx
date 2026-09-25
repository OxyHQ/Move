import { useTranslation } from 'react-i18next';
import {
  AdmonitionButton,
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';

/** A failed load, with a retry. */
export function QueryError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <AdmonitionRoot type="error">
      <AdmonitionRow>
        <AdmonitionIcon />
        <AdmonitionContent>
          <AdmonitionText>{message ?? t('common.loadError')}</AdmonitionText>
          <AdmonitionButton onPress={onRetry}>{t('common.retry')}</AdmonitionButton>
        </AdmonitionContent>
      </AdmonitionRow>
    </AdmonitionRoot>
  );
}
