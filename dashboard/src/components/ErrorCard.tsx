import { AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';

interface ErrorCardProps {
  message?: string;
  onRetry?: () => void;
}

export function ErrorCard({ message, onRetry }: ErrorCardProps) {
  const { t } = useLocale();

  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardContent className="flex items-center justify-between py-4 gap-4">
        <div className="flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
          <p className="text-sm text-destructive">{message ?? t('common.somethingWentWrong')}</p>
        </div>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
