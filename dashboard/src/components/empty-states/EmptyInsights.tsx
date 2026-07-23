import { Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useLocale } from '@/i18n/LocaleProvider';

export function EmptyInsights() {
  const { t } = useLocale();
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <Sparkles className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold mb-2">{t('insights.empty')}</h3>
        <p className="text-muted-foreground max-w-md">
          {t('insights.emptyCard.beforeAction')}{' '}
          <strong>{t('insights.emptyCard.action')}</strong>{' '}
          {t('insights.emptyCard.afterAction')}
        </p>
      </CardContent>
    </Card>
  );
}
