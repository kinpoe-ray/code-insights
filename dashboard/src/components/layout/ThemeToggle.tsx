import { Sun, Moon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme } from './ThemeProvider';
import { useLocale } from '@/i18n/LocaleProvider';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useLocale();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
        >
          {resolvedTheme === 'dark' ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
          <span className="sr-only">{t('theme.toggle')}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {t(resolvedTheme === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
      </TooltipContent>
    </Tooltip>
  );
}
