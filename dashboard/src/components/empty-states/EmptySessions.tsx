import { MessageSquare } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useLocale } from '@/i18n/LocaleProvider';

export function EmptySessions() {
  const { t } = useLocale();
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <MessageSquare className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold mb-2">{t('sessions.empty.title')}</h3>
        <p className="text-muted-foreground max-w-md">
          {t('sessions.empty.beforeCommand')}{' '}
          <code className="bg-muted px-1.5 py-0.5 rounded text-sm">code-insights sync</code>{' '}
          {t('sessions.empty.afterCommand')}
        </p>
      </CardContent>
    </Card>
  );
}
