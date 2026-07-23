import { Badge } from '@/components/ui/badge';
import {
  CheckCircle2,
  AlertCircle,
  XCircle,
  Ban,
  HelpCircle,
  Lightbulb,
  CalendarClock,
  FileText,
  Scale,
  GitFork,
  ArrowRightLeft,
  Clock,
} from 'lucide-react';
import type { InsightType, InsightMetadata } from '@/lib/types';
import type { LucideIcon } from 'lucide-react';
import { useLocale } from '@/i18n/LocaleProvider';

// --- Outcome Badge ---

export const OUTCOME_CONFIG = {
  success: { labelKey: 'insights.outcome.success', className: 'bg-green-500/10 text-green-600 border-green-500/20', icon: CheckCircle2 },
  partial: { labelKey: 'insights.outcome.partial', className: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20', icon: AlertCircle },
  abandoned: { labelKey: 'insights.outcome.abandoned', className: 'bg-gray-500/10 text-gray-500 border-gray-500/20', icon: XCircle },
  blocked: { labelKey: 'insights.outcome.blocked', className: 'bg-red-500/10 text-red-600 border-red-500/20', icon: Ban },
} as const;

export function OutcomeBadge({ outcome }: { outcome: string }) {
  const { t } = useLocale();
  const config = OUTCOME_CONFIG[outcome as keyof typeof OUTCOME_CONFIG];
  if (!config) return null;
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={config.className}>
      <Icon className="h-3 w-3 mr-1" />
      {t(config.labelKey)}
    </Badge>
  );
}

// --- Field icon config ---

const FIELD_CONFIG: Record<string, { icon: LucideIcon; color: string }> = {
  whatHappened: { icon: AlertCircle, color: 'text-muted-foreground' },
  why: { icon: HelpCircle, color: 'text-muted-foreground' },
  takeaway: { icon: Lightbulb, color: 'text-yellow-500' },
  appliesWhen: { icon: CalendarClock, color: 'text-muted-foreground' },
  situation: { icon: FileText, color: 'text-muted-foreground' },
  choice: { icon: CheckCircle2, color: 'text-blue-500' },
  reasoning: { icon: Scale, color: 'text-muted-foreground' },
  tradeoffs: { icon: ArrowRightLeft, color: 'text-muted-foreground' },
  revisitWhen: { icon: Clock, color: 'text-muted-foreground' },
  evidence: { icon: FileText, color: 'text-muted-foreground' },
};

// --- Shared metadata helpers ---

export function MetadataSection({ field, label, children, prominent }: { field: string; label: string; children: React.ReactNode; prominent?: boolean }) {
  const fieldConfig = FIELD_CONFIG[field];
  const FieldIcon = fieldConfig?.icon;

  return (
    <div className="space-y-0.5">
      <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {FieldIcon && <FieldIcon className={`h-3 w-3 ${fieldConfig.color}`} />}
        {label}
      </span>
      {prominent ? (
        <div className="rounded-md bg-muted/30 px-3 py-2">
          <p className="text-sm font-medium text-foreground">{children}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{children}</p>
      )}
    </div>
  );
}

export function formatAlternatives(alternatives: InsightMetadata['alternatives']): string {
  if (!alternatives || alternatives.length === 0) return '';
  return alternatives.map(a => {
    if (typeof a === 'string') return a;
    return a.rejected_because ? `${a.option} (rejected: ${a.rejected_because})` : a.option;
  }).join('; ');
}

// --- Type-specific content components ---

export function DecisionContent({ metadata }: { metadata: InsightMetadata }) {
  const { t } = useLocale();
  const hasStructured = metadata.situation || metadata.choice || metadata.reasoning;
  if (!hasStructured) return null;

  return (
    <div className="space-y-2.5">
      {metadata.situation && <MetadataSection field="situation" label={t('insights.metadata.situation')}>{metadata.situation}</MetadataSection>}
      {metadata.choice && <MetadataSection field="choice" label={t('insights.metadata.choice')} prominent>{metadata.choice}</MetadataSection>}
      {metadata.reasoning && <MetadataSection field="reasoning" label={t('insights.metadata.reasoning')}>{metadata.reasoning}</MetadataSection>}
      {metadata.alternatives && metadata.alternatives.length > 0 && (
        <div className="space-y-0.5">
          <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <GitFork className="h-3 w-3 text-muted-foreground" />
            {t('insights.metadata.alternatives')}
          </span>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {metadata.alternatives.map((alt, i) => {
              const label = typeof alt === 'string' ? alt : alt.option;
              const reason = typeof alt === 'string' ? undefined : alt.rejected_because;
              return (
                <Badge key={i} variant="outline" className="text-xs font-normal" title={reason ? t('insights.metadata.rejected', { reason }) : undefined}>
                  {label}
                  {reason && <span className="ml-1 text-muted-foreground/60">- {reason}</span>}
                </Badge>
              );
            })}
          </div>
        </div>
      )}
      {metadata.trade_offs && <MetadataSection field="tradeoffs" label={t('insights.metadata.tradeoffs')}>{metadata.trade_offs}</MetadataSection>}
      {metadata.revisit_when && metadata.revisit_when !== 'N/A' && (
        <MetadataSection field="revisitWhen" label={t('insights.metadata.revisitWhen')}>{metadata.revisit_when}</MetadataSection>
      )}
      {metadata.evidence && metadata.evidence.length > 0 && (
        <MetadataSection field="evidence" label={t('insights.metadata.evidence')}>{metadata.evidence.join(', ')}</MetadataSection>
      )}
    </div>
  );
}

export function LearningContent({ metadata }: { metadata: InsightMetadata }) {
  const { t } = useLocale();
  const hasStructured = metadata.symptom || metadata.root_cause || metadata.takeaway;
  if (!hasStructured) return null;

  return (
    <div className="space-y-2.5">
      {metadata.symptom && <MetadataSection field="whatHappened" label={t('insights.metadata.whatHappened')}>{metadata.symptom}</MetadataSection>}
      {metadata.root_cause && <MetadataSection field="why" label={t('insights.metadata.why')}>{metadata.root_cause}</MetadataSection>}
      {metadata.takeaway && <MetadataSection field="takeaway" label={t('insights.metadata.takeaway')} prominent>{metadata.takeaway}</MetadataSection>}
      {metadata.applies_when && <MetadataSection field="appliesWhen" label={t('insights.metadata.appliesWhen')}>{metadata.applies_when}</MetadataSection>}
    </div>
  );
}

export function SummaryContent({ metadata, bullets }: { metadata: InsightMetadata; bullets: string[] }) {
  return (
    <div className="space-y-2">
      {metadata.outcome && (
        <div>
          <OutcomeBadge outcome={metadata.outcome} />
        </div>
      )}
      {bullets.length > 0 && (
        <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
          {bullets.map((bullet, i) => (
            <li key={i} className="line-clamp-1">{bullet}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function renderTypeContent(type: InsightType, metadata: InsightMetadata, bullets: string[]) {
  switch (type) {
    case 'decision':
      return <DecisionContent metadata={metadata} />;
    case 'learning':
    case 'technique':
      return <LearningContent metadata={metadata} />;
    case 'summary':
      return <SummaryContent metadata={metadata} bullets={bullets} />;
    default:
      return null;
  }
}
