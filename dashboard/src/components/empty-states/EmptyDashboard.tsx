import { TerminalSquare } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useLocale } from '@/i18n/LocaleProvider';

export function EmptyDashboard() {
  const { t } = useLocale();

  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <TerminalSquare className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold mb-2">{t('dashboard.empty.title')}</h3>
        <p className="text-muted-foreground max-w-md">
          {t('dashboard.empty.beforeCommand')}{' '}
          <code className="bg-muted px-1.5 py-0.5 rounded text-sm">code-insights sync</code>{' '}
          {t('dashboard.empty.afterCommand')}
        </p>
      </CardContent>
    </Card>
  );
}
