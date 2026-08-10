import { Link, useLocation, useNavigate } from 'react-router';
import {
  LayoutDashboard,
  Lightbulb,
  BarChart3,
  Download,
  Settings,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Github,
  Sparkles,
  Search,
  CircleHelp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetClose,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from './ThemeToggle';
import { LanguageToggle } from './LanguageToggle';
import { Logo } from '@/components/brand/Logo';
import { cn } from '@/lib/utils';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages/catalog';
import { restartProductOnboarding } from '@/lib/product-onboarding';

const NAV_ITEMS: Array<{ href: string; labelKey: MessageKey; icon: typeof LayoutDashboard; exact: boolean }> = [
  { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, exact: true },
  { href: '/sessions', labelKey: 'nav.sessions', icon: MessageSquare, exact: false },
  { href: '/insights', labelKey: 'nav.insights', icon: Lightbulb, exact: false },
  { href: '/analytics', labelKey: 'nav.analytics', icon: BarChart3, exact: false },
  { href: '/patterns', labelKey: 'nav.patterns', icon: Sparkles, exact: false },
  { href: '/export', labelKey: 'nav.export', icon: Download, exact: false },
  { href: '/settings', labelKey: 'nav.settings', icon: Settings, exact: false },
];

const PRIMARY_NAV_ITEMS = NAV_ITEMS.slice(0, 5);
const BOTTOM_TABS = NAV_ITEMS.slice(0, 4);

interface HeaderProps {
  onOpenSearch?: () => void;
}

export function Header({ onOpenSearch }: HeaderProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { t } = useLocale();

  const isActive = (href: string, exact: boolean) =>
    exact ? pathname === href : pathname.startsWith(href);
  const moreActive = NAV_ITEMS.slice(4).some(({ href, exact }) => isActive(href, exact));
  const handleRestartOnboarding = () => {
    restartProductOnboarding();
    navigate('/dashboard');
  };

  return (
    <>
      <header className="app-material fixed inset-x-0 top-0 z-50 border-b border-border/60">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4 sm:px-5">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label={t('nav.openNavigation')}>
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="flex w-72 flex-col p-0">
              <SheetHeader className="border-b px-5 py-4">
                <SheetTitle className="flex items-center gap-2 text-[15px] font-semibold">
                  <Logo className="h-5 w-5" />
                  Code Insights
                </SheetTitle>
                <SheetDescription className="sr-only">{t('nav.navigationMenu')}</SheetDescription>
              </SheetHeader>
              <nav className="px-3 py-3" aria-label={t('nav.navigationMenu')}>
                {NAV_ITEMS.map(({ href, labelKey, icon: Icon, exact }) => (
                  <Button
                    key={href}
                    variant="ghost"
                    asChild
                    className={cn(
                      'mb-1 h-10 w-full justify-start px-3',
                      isActive(href, exact)
                        ? 'bg-accent text-accent-foreground font-semibold'
                        : 'text-muted-foreground',
                    )}
                  >
                    <Link to={href}>
                      <Icon className="mr-2 h-4 w-4" />
                      {t(labelKey)}
                    </Link>
                  </Button>
                ))}
              </nav>
              <div className="mt-auto border-t p-3">
                <SheetClose asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-10 w-full justify-start px-3 text-muted-foreground"
                    onClick={handleRestartOnboarding}
                  >
                    <CircleHelp className="mr-2 h-4 w-4" />
                    {t('onboarding.nav.replay')}
                  </Button>
                </SheetClose>
              </div>
            </SheetContent>
          </Sheet>

          <Link
            to="/dashboard"
            className="flex shrink-0 items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/35"
          >
            <Logo className="h-5 w-5" />
            <span className="text-[15px] font-semibold tracking-[-0.02em]">Code Insights</span>
          </Link>

          <nav
            className="hidden items-center gap-0.5 rounded-xl bg-muted/65 p-1 lg:flex"
            aria-label={t('nav.navigationMenu')}
          >
            {PRIMARY_NAV_ITEMS.map(({ href, labelKey, icon: Icon, exact }) => {
              const active = isActive(href, exact);
              return (
                <Link
                  key={href}
                  to={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-8 items-center gap-1.5 rounded-[9px] px-2.5 text-[13px] font-medium text-muted-foreground outline-none transition-[color,background-color,box-shadow,transform] duration-150 hover:text-foreground active:scale-[0.985] focus-visible:ring-3 focus-visible:ring-ring/35 motion-reduce:transition-none motion-reduce:active:scale-100 xl:px-3',
                    active && 'bg-card text-foreground shadow-[0_1px_3px_hsl(240_10%_4%/0.10)]',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(labelKey)}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="outline"
              size="sm"
              className="hidden h-8 w-40 items-center justify-between gap-2 rounded-[9px] border-border/70 bg-card/80 px-2.5 text-xs text-muted-foreground lg:flex xl:w-48"
              onClick={onOpenSearch}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Search className="h-3.5 w-3.5" />
                <span className="truncate">{t('nav.search')}</span>
              </span>
              <kbd className="rounded-md border border-border/70 bg-muted/70 px-1.5 py-0.5 font-sans text-[10px]">⌘K</kbd>
            </Button>

            <LanguageToggle />
            <ThemeToggle />

            <Button
              variant={pathname.startsWith('/settings') ? 'secondary' : 'ghost'}
              size="icon-sm"
              asChild
              className="hidden sm:inline-flex"
            >
              <Link to="/settings" aria-label={t('nav.settings')}>
                <Settings className="h-4 w-4" />
              </Link>
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="hidden sm:inline-flex" aria-label={t('nav.more')}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44 rounded-xl p-1.5 shadow-xl">
                <DropdownMenuItem className="h-9 rounded-lg" onSelect={handleRestartOnboarding}>
                  <CircleHelp className="h-4 w-4" />
                  {t('onboarding.nav.replay')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild className="h-9 rounded-lg">
                  <Link to="/export">
                    <Download className="h-4 w-4" />
                    {t('nav.export')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild className="h-9 rounded-lg">
                  <a href="https://github.com/melagiri/code-insights" target="_blank" rel="noopener noreferrer">
                    <Github className="h-4 w-4" />
                    GitHub
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <nav className="app-material fixed inset-x-0 bottom-0 z-50 flex h-[calc(3.5rem+env(safe-area-inset-bottom))] items-start border-t pt-1 md:hidden" aria-label={t('nav.navigationMenu')}>
        {BOTTOM_TABS.map(({ href, labelKey, icon: Icon, exact }) => {
          const active = isActive(href, exact);
          return (
            <Link
              key={href}
              to={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <Icon className="h-5 w-5" />
              <span>{t(labelKey)}</span>
            </Link>
          );
        })}
        <Sheet>
          <SheetTrigger asChild>
            <button
              className={cn(
                'flex h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium',
                moreActive ? 'text-primary' : 'text-muted-foreground',
              )}
              aria-current={moreActive ? 'page' : undefined}
            >
              <MoreHorizontal className="h-5 w-5" />
              <span>{t('nav.more')}</span>
            </button>
          </SheetTrigger>
          <SheetContent side="bottom" className="h-auto rounded-t-3xl">
            <SheetHeader className="px-4 py-3">
              <SheetTitle className="sr-only text-sm font-semibold">{t('nav.moreOptions')}</SheetTitle>
              <SheetDescription className="sr-only">{t('nav.additionalOptions')}</SheetDescription>
            </SheetHeader>
            <nav className="grid grid-cols-2 gap-2 px-4 pb-8">
              {NAV_ITEMS.slice(4).map(({ href, labelKey, icon: Icon }) => (
                <Button
                  key={href}
                  variant={pathname.startsWith(href) ? 'secondary' : 'outline'}
                  asChild
                  className="h-11 justify-start gap-2"
                >
                  <Link to={href}>
                    <Icon className="h-4 w-4" />
                    {t(labelKey)}
                  </Link>
                </Button>
              ))}
              <SheetClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 justify-start gap-2"
                  onClick={handleRestartOnboarding}
                >
                  <CircleHelp className="h-4 w-4" />
                  {t('onboarding.nav.replay')}
                </Button>
              </SheetClose>
            </nav>
          </SheetContent>
        </Sheet>
      </nav>
    </>
  );
}
