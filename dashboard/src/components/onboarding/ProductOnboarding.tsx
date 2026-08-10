import { Link } from 'react-router';
import {
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  CircleSlash2,
  Clock3,
  Lightbulb,
  MessageSquare,
  Sparkles,
  Target,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProductOnboarding, useProductOnboardingProgress } from '@/hooks/useProductOnboarding';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages/catalog';
import type { ProductOnboardingModule } from '@/lib/product-onboarding';
import { cn } from '@/lib/utils';

type ContextualModule = Extract<ProductOnboardingModule, 'insights' | 'analytics' | 'patterns'>;

interface ModuleContent {
  icon: LucideIcon;
  iconClassName: string;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  stepKeys: [MessageKey, MessageKey, MessageKey];
  whenKey: MessageKey;
  notForKey: MessageKey;
  outcomeKey: MessageKey;
  actionKey: MessageKey;
}

const MODULE_CONTENT: Record<ContextualModule, ModuleContent> = {
  insights: {
    icon: Lightbulb,
    iconClassName: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
    titleKey: 'onboarding.insights.title',
    descriptionKey: 'onboarding.insights.description',
    whenKey: 'onboarding.insights.when',
    notForKey: 'onboarding.insights.notFor',
    outcomeKey: 'onboarding.insights.outcome',
    actionKey: 'onboarding.insights.action',
    stepKeys: [
      'onboarding.insights.step1',
      'onboarding.insights.step2',
      'onboarding.insights.step3',
    ],
  },
  analytics: {
    icon: BarChart3,
    iconClassName: 'bg-blue-500/12 text-blue-700 dark:text-blue-300',
    titleKey: 'onboarding.analytics.title',
    descriptionKey: 'onboarding.analytics.description',
    whenKey: 'onboarding.analytics.when',
    notForKey: 'onboarding.analytics.notFor',
    outcomeKey: 'onboarding.analytics.outcome',
    actionKey: 'onboarding.analytics.action',
    stepKeys: [
      'onboarding.analytics.step1',
      'onboarding.analytics.step2',
      'onboarding.analytics.step3',
    ],
  },
  patterns: {
    icon: Sparkles,
    iconClassName: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
    titleKey: 'onboarding.patterns.title',
    descriptionKey: 'onboarding.patterns.description',
    whenKey: 'onboarding.patterns.when',
    notForKey: 'onboarding.patterns.notFor',
    outcomeKey: 'onboarding.patterns.outcome',
    actionKey: 'onboarding.patterns.action',
    stepKeys: [
      'onboarding.patterns.step1',
      'onboarding.patterns.step2',
      'onboarding.patterns.step3',
    ],
  },
};

interface ContextualOnboardingProps {
  module: ContextualModule;
  className?: string;
  onAction?: () => void;
}

export function ContextualOnboarding({ module, className, onAction }: ContextualOnboardingProps) {
  const { t } = useLocale();
  const { visible, dismiss, complete } = useProductOnboarding(module);
  const content = MODULE_CONTENT[module];
  const Icon = content.icon;

  if (!visible) return null;

  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-2xl border border-primary/15 bg-accent/45 px-4 py-4 pr-11 sm:px-5 sm:py-5 sm:pr-12',
        className,
      )}
      aria-labelledby={`onboarding-${module}-title`}
      data-testid={`onboarding-${module}`}
    >
      <div className="flex items-start gap-3.5">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', content.iconClassName)}>
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">
            {t('onboarding.common.pageGuide')}
          </p>
          <h2 id={`onboarding-${module}-title`} className="mt-1 text-[15px] font-semibold tracking-[-0.01em]">
            {t(content.titleKey)}
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            {t(content.descriptionKey)}
          </p>

          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/[0.045] px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t('onboarding.common.when')}
              </div>
              <p className="mt-1 text-xs leading-5 text-foreground/85">{t(content.whenKey)}</p>
            </div>
            <div className="rounded-xl border border-border/65 bg-card/55 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                <CircleSlash2 className="h-3.5 w-3.5" />
                {t('onboarding.common.notFor')}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(content.notForKey)}</p>
            </div>
          </div>

          <ol className="mt-3 grid gap-2 sm:grid-cols-3">
            {content.stepKeys.map((stepKey, index) => (
              <li key={stepKey} className="flex items-start gap-2 rounded-xl border border-border/65 bg-card/70 px-3 py-2.5 text-xs leading-5">
                <span className="font-tabular flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                  {index + 1}
                </span>
                <span>{t(stepKey)}</span>
              </li>
            ))}
          </ol>

          <div className="mt-3 flex flex-col gap-3 rounded-xl border border-primary/15 bg-primary/[0.045] px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <Target className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-primary">
                  {t('onboarding.common.takeaway')}
                </p>
                <p className="mt-0.5 text-xs leading-5 text-foreground/85">{t(content.outcomeKey)}</p>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              className="h-8 shrink-0 text-xs"
              onClick={() => {
                onAction?.();
                complete();
              }}
            >
              <Check className="h-3.5 w-3.5" />
              {t(content.actionKey)}
            </Button>
          </div>
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute right-2.5 top-2.5 text-muted-foreground"
        aria-label={t('onboarding.common.dismiss')}
        onClick={dismiss}
      >
        <X />
      </Button>
    </section>
  );
}

const JOURNEY_STEPS: Array<{
  module: Extract<ProductOnboardingModule, 'sessions' | 'insights' | 'analytics' | 'patterns'>;
  href: string;
  icon: LucideIcon;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  taskKey: MessageKey;
  resultKey: MessageKey;
}> = [
  {
    module: 'sessions',
    href: '/sessions',
    icon: MessageSquare,
    labelKey: 'onboarding.dashboard.sessionsTitle',
    descriptionKey: 'onboarding.dashboard.sessionsDescription',
    taskKey: 'onboarding.dashboard.sessionsTask',
    resultKey: 'onboarding.dashboard.sessionsResult',
  },
  {
    module: 'insights',
    href: '/insights',
    icon: Lightbulb,
    labelKey: 'onboarding.dashboard.insightsTitle',
    descriptionKey: 'onboarding.dashboard.insightsDescription',
    taskKey: 'onboarding.dashboard.insightsTask',
    resultKey: 'onboarding.dashboard.insightsResult',
  },
  {
    module: 'analytics',
    href: '/analytics',
    icon: BarChart3,
    labelKey: 'onboarding.dashboard.analyticsTitle',
    descriptionKey: 'onboarding.dashboard.analyticsDescription',
    taskKey: 'onboarding.dashboard.analyticsTask',
    resultKey: 'onboarding.dashboard.analyticsResult',
  },
  {
    module: 'patterns',
    href: '/patterns',
    icon: Sparkles,
    labelKey: 'onboarding.dashboard.patternsTitle',
    descriptionKey: 'onboarding.dashboard.patternsDescription',
    taskKey: 'onboarding.dashboard.patternsTask',
    resultKey: 'onboarding.dashboard.patternsResult',
  },
];

export function DashboardOnboardingChecklist() {
  const { t } = useLocale();
  const { visible, dismiss, complete } = useProductOnboarding('dashboard');
  const progress = useProductOnboardingProgress();
  const completedCount = JOURNEY_STEPS.filter(({ module }) => progress[module] === 'completed').length;

  if (!visible) return null;

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-primary/20 bg-accent/50 p-4 sm:p-5"
      aria-labelledby="product-onboarding-title"
      data-testid="onboarding-dashboard"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl pr-8">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            {t('onboarding.dashboard.eyebrow')}
            <span className="flex items-center gap-1 rounded-full bg-primary/8 px-2 py-0.5 font-medium normal-case tracking-normal text-primary/80">
              <Clock3 className="h-3 w-3" />
              {t('onboarding.dashboard.duration')}
            </span>
          </div>
          <h2 id="product-onboarding-title" className="mt-2 text-lg font-semibold tracking-[-0.02em]">
            {t('onboarding.dashboard.title')}
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            {t('onboarding.dashboard.description')}
          </p>
        </div>

        <div className="w-full shrink-0 lg:w-44">
          <div className="flex items-center justify-between text-xs font-medium">
            <span>{t('onboarding.dashboard.progress')}</span>
            <span className="font-tabular text-primary">
              {t('onboarding.dashboard.progressCount', { completed: completedCount, total: JOURNEY_STEPS.length })}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/10">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${(completedCount / JOURNEY_STEPS.length) * 100}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mt-4 flex snap-x gap-2 overflow-x-auto pb-1 md:grid md:grid-cols-2 md:overflow-visible md:pb-0 xl:grid-cols-4">
        {JOURNEY_STEPS.map(({ module, href, icon: Icon, labelKey, descriptionKey, taskKey, resultKey }, index) => {
          const completed = progress[module] === 'completed';
          return (
            <Link
              key={module}
              to={href}
              className="group flex min-h-44 min-w-[280px] snap-start items-start gap-3 rounded-xl border border-border/70 bg-card/80 p-3.5 outline-none transition-[border-color,background-color,transform] hover:border-primary/30 hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/35 active:scale-[0.99] motion-reduce:transition-none md:min-w-0"
            >
              <span className={cn(
                'font-tabular flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold',
                completed ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : 'bg-primary/10 text-primary',
              )}>
                {completed ? <CheckCircle2 className="h-4 w-4" /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col self-stretch">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <Icon className="h-3.5 w-3.5 text-primary" />
                  {t(labelKey)}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {t(descriptionKey)}
                </span>
                <span className="mt-3 space-y-2 border-t border-border/55 pt-2.5">
                  <span className="flex items-start gap-2 text-[11px] leading-4.5">
                    <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <span>
                      <span className="block font-medium text-foreground">{t('onboarding.common.task')}</span>
                      <span className="text-muted-foreground">{t(taskKey)}</span>
                    </span>
                  </span>
                  <span className="flex items-start gap-2 text-[11px] leading-4.5">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
                    <span>
                      <span className="block font-medium text-foreground">{t('onboarding.common.result')}</span>
                      <span className="text-muted-foreground">{t(resultKey)}</span>
                    </span>
                  </span>
                </span>
              </span>
            </Link>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-9" asChild>
          <Link to="/sessions" onClick={complete}>
            {t('onboarding.dashboard.start')}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-9 text-muted-foreground" onClick={dismiss}>
          {t('onboarding.dashboard.later')}
        </Button>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute right-3 top-3 text-muted-foreground"
        aria-label={t('onboarding.common.dismiss')}
        onClick={dismiss}
      >
        <X />
      </Button>
    </section>
  );
}
