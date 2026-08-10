import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Header } from './Header';
import { CommandPalette } from '@/components/search/CommandPalette';
import { useCommandPalette } from '@/hooks/useCommandPalette';
import { useLocale } from '@/i18n/LocaleProvider';

export function Layout() {
  const { isOpen, setIsOpen, open, close } = useCommandPalette();
  const { t } = useLocale();

  // Global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        open();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-canvas">
        <a
          href="#main-content"
          className="fixed left-4 top-2 z-[60] -translate-y-16 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background shadow-lg transition-transform focus:translate-y-0 focus:outline-none focus:ring-3 focus:ring-ring/35 motion-reduce:transition-none"
        >
          {t('nav.skipToContent')}
        </a>
        <Header onOpenSearch={open} />
        {/* Header and mobile navigation reserve their own stable layout space. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="pt-16 pb-[calc(3.75rem+env(safe-area-inset-bottom))] outline-none md:pb-0"
        >
          <Outlet />
        </main>
        <Toaster />
        <CommandPalette isOpen={isOpen} onClose={close} />
      </div>
    </TooltipProvider>
  );
}
