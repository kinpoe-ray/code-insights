import type { Session, SessionListSignal } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages/catalog';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Sparkles,
  Target,
  X,
} from 'lucide-react';

export type ReviewPreset = 'all' | 'needs-review' | 'blocked' | 'low-prompt';

export type ReviewPresetCounts = Record<Exclude<ReviewPreset, 'all'>, number>;

export const LOW_PROMPT_SCORE_THRESHOLD = 75;

export function matchesReviewPreset(
  signal: SessionListSignal | undefined,
  preset: ReviewPreset,
): boolean {
  if (preset === 'all') return true;
  if (!signal?.is_analyzed) return false;

  const needsReviewOutcome =
    signal.outcome === 'partial' ||
    signal.outcome === 'blocked' ||
    signal.outcome === 'abandoned';
  const hasLowPromptScore =
    signal.prompt_quality_score !== null &&
    signal.prompt_quality_score < LOW_PROMPT_SCORE_THRESHOLD;

  if (preset === 'needs-review') return needsReviewOutcome || hasLowPromptScore;
  if (preset === 'blocked') return signal.outcome === 'blocked';
  return hasLowPromptScore;
}

export function getReviewPresetCounts(
  sessions: Array<Pick<Session, 'id'>>,
  signals: SessionListSignal[],
): ReviewPresetCounts {
  const signalsBySession = new Map(signals.map((signal) => [signal.session_id, signal]));
  const counts: ReviewPresetCounts = {
    'needs-review': 0,
    blocked: 0,
    'low-prompt': 0,
  };

  for (const session of sessions) {
    const signal = signalsBySession.get(session.id);
    if (matchesReviewPreset(signal, 'needs-review')) counts['needs-review'] += 1;
    if (matchesReviewPreset(signal, 'blocked')) counts.blocked += 1;
    if (matchesReviewPreset(signal, 'low-prompt')) counts['low-prompt'] += 1;
  }

  return counts;
}

interface SessionOnboardingWelcomeProps {
  onStart: () => void;
  onSkip: () => void;
  onClose: () => void;
}

export function SessionOnboardingWelcome({
  onStart,
  onSkip,
  onClose,
}: SessionOnboardingWelcomeProps) {
  const { t } = useLocale();

  return (
    <section
      className="relative mx-4 mt-3 rounded-xl border border-primary/15 bg-accent/55 px-4 py-3.5 pr-11"
      aria-labelledby="session-onboarding-welcome-title"
      data-testid="session-onboarding-welcome"
    >
      <div className="flex gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-violet-500">
          <Sparkles className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0">
          <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-primary">
            <Clock3 className="h-3 w-3" />
            {t('sessions.onboarding.welcomeEyebrow')}
          </p>
          <h2 id="session-onboarding-welcome-title" className="text-sm font-semibold">
            {t('sessions.onboarding.welcomeTitle')}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('sessions.onboarding.welcomeDescription')}
          </p>
          <ol className="mt-3 grid gap-1.5 sm:grid-cols-3">
            {([
              'sessions.onboarding.welcomeStep1',
              'sessions.onboarding.welcomeStep2',
              'sessions.onboarding.welcomeStep3',
            ] as const).map((key, index) => (
              <li key={key} className="flex items-start gap-2 rounded-lg border border-border/60 bg-card/65 px-2.5 py-2 text-[11px] leading-4.5">
                <span className="font-tabular flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[9px] font-semibold text-primary">
                  {index + 1}
                </span>
                <span>{t(key)}</span>
              </li>
            ))}
          </ol>
          <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-primary/[0.055] px-2.5 py-2 text-[11px] leading-4.5 text-foreground/85">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
            <span>{t('sessions.onboarding.welcomeOutcome')}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Button type="button" size="sm" className="h-8 text-xs" onClick={onStart}>
              {t('sessions.onboarding.start')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-8 text-xs text-primary" onClick={onSkip}>
              {t('sessions.onboarding.skip')}
            </Button>
          </div>
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute right-2 top-2 text-muted-foreground"
        aria-label={t('sessions.onboarding.closeWelcome')}
        onClick={onClose}
      >
        <X />
      </Button>
    </section>
  );
}

const REVIEW_PRESETS: Array<{
  value: Exclude<ReviewPreset, 'all'>;
  labelKey: MessageKey;
  icon: typeof CircleHelp;
  iconClassName: string;
}> = [
  {
    value: 'needs-review',
    labelKey: 'sessions.review.needsReview',
    icon: CircleHelp,
    iconClassName: 'text-violet-500',
  },
  {
    value: 'blocked',
    labelKey: 'sessions.review.blocked',
    icon: AlertTriangle,
    iconClassName: 'text-amber-500',
  },
  {
    value: 'low-prompt',
    labelKey: 'sessions.review.lowPrompt',
    icon: Target,
    iconClassName: 'text-teal-500',
  },
];

interface SessionReviewPresetBarProps {
  value: ReviewPreset;
  counts: ReviewPresetCounts;
  onValueChange: (value: ReviewPreset) => void;
  className?: string;
}

export function SessionReviewPresetBar({
  value,
  counts,
  onValueChange,
  className,
}: SessionReviewPresetBarProps) {
  const { t, formatNumber } = useLocale();

  return (
    <div
      className={cn('flex shrink-0 gap-1.5 overflow-x-auto border-b px-4 pb-3 pt-2', className)}
      aria-label={t('sessions.review.label')}
    >
      {REVIEW_PRESETS.map(({ value: preset, labelKey, icon: Icon, iconClassName }) => {
        const active = value === preset;
        const label = t(labelKey);
        const count = counts[preset];
        return (
          <Button
            type="button"
            key={preset}
            variant="outline"
            size="sm"
            className={cn(
              'h-8 gap-1.5 rounded-lg px-2.5 text-[11px] font-medium',
              active && 'border-primary/35 bg-accent text-accent-foreground shadow-none',
            )}
            aria-pressed={active}
            aria-label={t('sessions.review.optionLabel', { label, count })}
            onClick={() => onValueChange(active ? 'all' : preset)}
          >
            <Icon className={cn('h-3.5 w-3.5', iconClassName)} />
            <span>{label}</span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 font-tabular text-[10px] leading-none text-muted-foreground">
              {formatNumber(count)}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

interface SessionOnboardingCoachProps {
  step: 1 | 2 | 3 | 4;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
  compactAction?: boolean;
  className?: string;
}

export function SessionOnboardingCoach({
  step,
  title,
  description,
  actionLabel,
  onAction,
  onDismiss,
  compactAction = false,
  className,
}: SessionOnboardingCoachProps) {
  const { t } = useLocale();
  const titleId = `session-onboarding-step-${step}-title`;

  return (
    <aside
      className={cn(
        'absolute z-40 w-[208px] rounded-xl border bg-popover px-3.5 py-3 text-popover-foreground shadow-xl',
        className,
      )}
      role="dialog"
      aria-labelledby={titleId}
      data-testid={`session-onboarding-step-${step}`}
    >
      <div className="flex items-center justify-between text-[11px] font-semibold text-primary">
        <span>{t('sessions.onboarding.stepCounter', { step })}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="-mr-1.5 text-muted-foreground"
          aria-label={t('sessions.onboarding.dismiss')}
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
      <h3 id={titleId} className="mt-1.5 text-[13px] font-semibold leading-snug">
        {title}
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        {description}
      </p>
      <Button
        type="button"
        variant={compactAction ? 'link' : 'default'}
        size="xs"
        className={cn('mt-2', compactAction && 'h-6 px-0')}
        onClick={onAction}
      >
        {actionLabel}
        <ArrowRight className="h-3 w-3" />
      </Button>
    </aside>
  );
}
