import { Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';

export function LanguageToggle() {
  const { locale, setLocale, t } = useLocale();
  const chinese = locale === 'zh-CN';

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-9 gap-1.5 px-2 text-xs font-medium"
      aria-label={t(chinese ? 'language.switchToEnglish' : 'language.switchToChinese')}
      onClick={() => setLocale(chinese ? 'en-US' : 'zh-CN')}
    >
      <Languages className="h-4 w-4" aria-hidden="true" />
      <span>{chinese ? 'EN' : '中文'}</span>
    </Button>
  );
}
