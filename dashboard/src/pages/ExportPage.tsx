import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useProjects } from '@/hooks/useProjects';
import { useInsights } from '@/hooks/useInsights';
import { useExportGenerate } from '@/hooks/useExport';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Download,
  ChevronRight,
  Copy,
  Check,
  Loader2,
  Bot,
  BookOpen,
  Layers,
  Zap,
  Library,
  Folder,
  Globe,
  NotebookPen,
  StickyNote,
} from 'lucide-react';
import type { ExportGenerateFormat, ExportGenerateScope, ExportGenerateDepth } from '@/lib/api';
import { useLocale } from '@/i18n/LocaleProvider';

type WizardStep = 1 | 2 | 3 | 4;

const DEPTH_CAPS: Record<ExportGenerateDepth, number> = {
  essential: 25,
  standard: 80,
  comprehensive: 200,
};

export default function ExportPage() {
  const { t } = useLocale();
  const { data: projects = [] } = useProjects();
  const { data: allInsights = [] } = useInsights();
  const { state: exportState, generate, cancel, reset: resetExport } = useExportGenerate();

  const [step, setStep] = useState<WizardStep>(1);
  const [scope, setScope] = useState<ExportGenerateScope | null>(null);
  const [projectId, setProjectId] = useState<string>('');
  const [format_, setFormat] = useState<ExportGenerateFormat>('agent-rules');
  const [depth, setDepth] = useState<ExportGenerateDepth>('standard');
  const [copied, setCopied] = useState(false);
  const steps = [
    { n: 1 as WizardStep, label: t('export.step.scope') },
    { n: 2 as WizardStep, label: t('export.step.configure') },
    { n: 3 as WizardStep, label: t('export.step.generate') },
    { n: 4 as WizardStep, label: t('export.step.review') },
  ];

  // Compute insight counts for the stat bar in Step 2
  const { scopedInsights, depthCappedCount } = useMemo(() => {
    // Exclude summaries — they're per-session artifacts, not cross-session knowledge
    const nonSummary = allInsights.filter((i) => i.type !== 'summary');

    const scopedInsights = scope === 'project' && projectId
      ? nonSummary.filter((i) => i.project_id === projectId)
      : nonSummary;

    const depthCap = DEPTH_CAPS[depth];
    const depthCappedCount = Math.min(scopedInsights.length, depthCap);

    return { scopedInsights, depthCappedCount };
  }, [allInsights, scope, projectId, depth]);

  const selectedProject = projects.find((p) => p.id === projectId);
  const hasInsights = scopedInsights.length > 0;

  const getFilename = (): string => {
    const today = format(new Date(), 'yyyy-MM-dd');
    const projectSlug = selectedProject?.name
      ? selectedProject.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      : 'all-projects';
    const scopeSlug = scope === 'project' ? projectSlug : 'all-projects';
    return `${scopeSlug}-${format_}-${today}.md`;
  };

  const handleGoToStep2 = () => {
    if (scope === 'project' && !projectId) {
      toast.error(t('export.selectProjectError'));
      return;
    }
    setStep(2);
  };

  const handleStartGeneration = async () => {
    if (!scope) return;
    setStep(3);

    await generate({
      scope,
      projectId: scope === 'project' ? projectId : undefined,
      format: format_,
      depth,
    });
  };

  // Auto-advance to Step 4 when generation completes
  const isComplete = exportState.status === 'complete';
  const isError = exportState.status === 'error';

  const handleGoToReview = () => {
    if (isComplete) setStep(4);
  };

  const handleDownload = () => {
    if (!exportState.content) return;
    const blob = new Blob([exportState.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = getFilename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(t('export.downloaded'));
  };

  const handleCopy = async () => {
    if (!exportState.content) return;
    try {
      await navigator.clipboard.writeText(exportState.content);
      setCopied(true);
      toast.success(t('export.copiedToast'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('export.copyFailed'));
    }
  };

  const handleStartOver = () => {
    cancel();
    resetExport();
    setStep(1);
    setScope(null);
    setProjectId('');
    setFormat('agent-rules');
    setDepth('standard');
    setCopied(false);
  };

  const handleCancelGeneration = () => {
    cancel();
    setStep(2);
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('export.title')}</h1>
        <p className="text-muted-foreground">{t('export.subtitle')}</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1 flex-wrap">
        {steps.map((s, i) => (
          <div key={s.n} className="flex items-center gap-1">
            <div
              className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${
                step === s.n
                  ? 'bg-primary text-primary-foreground'
                  : step > s.n
                    ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              <span>{s.n}</span>
              <span>{s.label}</span>
            </div>
            {i < steps.length - 1 && (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </div>
        ))}
      </div>

      {/* ── Step 1: Scope ── */}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('export.scope.intro')}
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            <ExportTypeCard
              icon={Globe}
              title={t('export.scope.allProjects')}
              description={t('export.scope.allProjectsDescription')}
              selected={scope === 'all'}
              onSelect={() => { setScope('all'); setProjectId(''); }}
            />
            <ExportTypeCard
              icon={Folder}
              title={t('export.scope.singleProject')}
              description={t('export.scope.singleProjectDescription')}
              selected={scope === 'project'}
              onSelect={() => setScope('project')}
            />
          </div>

          {scope === 'project' && (
            <div className="max-w-sm">
              <label className="text-sm font-medium mb-1.5 block">{t('export.scope.project')}</label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('export.scope.selectProject')} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              onClick={handleGoToStep2}
              disabled={!scope || (scope === 'project' && !projectId)}
            >
              {t('export.nextConfigure')}
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 2: Configure ── */}
      {step === 2 && (
        <div className="space-y-4">
          {/* Format */}
          <div>
            <p className="text-sm font-medium mb-3">{t('export.outputFormat')}</p>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <ExportTypeCard
                icon={Bot}
                title={t('export.format.agentRules')}
                description={t('export.format.agentRulesDescription')}
                selected={format_ === 'agent-rules'}
                onSelect={() => setFormat('agent-rules')}
              />
              <ExportTypeCard
                icon={BookOpen}
                title={t('export.format.knowledgeBrief')}
                description={t('export.format.knowledgeBriefDescription')}
                selected={format_ === 'knowledge-brief'}
                onSelect={() => setFormat('knowledge-brief')}
              />
              <ExportTypeCard
                icon={NotebookPen}
                title={t('export.format.obsidian')}
                description={t('export.format.obsidianDescription')}
                selected={format_ === 'obsidian'}
                onSelect={() => setFormat('obsidian')}
              />
              <ExportTypeCard
                icon={StickyNote}
                title={t('export.format.notion')}
                description={t('export.format.notionDescription')}
                selected={format_ === 'notion'}
                onSelect={() => setFormat('notion')}
              />
            </div>
          </div>

          {/* Depth */}
          <div>
            <p className="text-sm font-medium mb-3">{t('export.depth.title')}</p>
            <div className="grid gap-3 md:grid-cols-3">
              <ExportTypeCard
                icon={Zap}
                title={t('export.depth.essential')}
                description={t('export.depth.essentialDescription')}
                selected={depth === 'essential'}
                onSelect={() => setDepth('essential')}
              />
              <ExportTypeCard
                icon={Layers}
                title={t('export.depth.standard')}
                description={t('export.depth.standardDescription')}
                selected={depth === 'standard'}
                onSelect={() => setDepth('standard')}
              />
              <ExportTypeCard
                icon={Library}
                title={t('export.depth.comprehensive')}
                description={t('export.depth.comprehensiveDescription')}
                selected={depth === 'comprehensive'}
                onSelect={() => setDepth('comprehensive')}
              />
            </div>
          </div>

          {/* Stat bar */}
          <div className="rounded-lg bg-muted px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-lg font-bold">{scopedInsights.length}</p>
              <p className="text-xs text-muted-foreground">{t('export.totalInsights')}</p>
            </div>
            <div>
              <p className="text-lg font-bold">
                {depthCappedCount < scopedInsights.length
                  ? t('export.countOf', { count: depthCappedCount, total: scopedInsights.length })
                  : scopedInsights.length}
              </p>
              <p className="text-xs text-muted-foreground">{t('export.insightsToSynthesize')}</p>
            </div>
            <div>
              <p className="text-lg font-bold">
                {scopedInsights.filter((i) => i.type === 'decision').length}
              </p>
              <p className="text-xs text-muted-foreground">{t('export.decisions')}</p>
            </div>
            <div>
              <p className="text-lg font-bold">
                {scopedInsights.filter((i) => i.type === 'learning').length}
              </p>
              <p className="text-xs text-muted-foreground">{t('export.learnings')}</p>
            </div>
          </div>

          {!hasInsights && (
            <p className="text-sm text-muted-foreground text-center py-2">
              {t('export.noInsights')}
            </p>
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(1)}>
              {t('export.back')}
            </Button>
            <Button onClick={handleStartGeneration} disabled={!hasInsights}>
              {t('export.generateWithAi')}
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 3: Generate ── */}
      {step === 3 && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col items-center gap-4 py-8 text-center">
                {(exportState.status === 'loading_insights' || exportState.status === 'synthesizing') && (
                  <>
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    <div className="space-y-1">
                      <p className="font-medium">
                        {exportState.status === 'loading_insights'
                          ? t('export.loadingInsights')
                          : t('export.synthesizing')}
                      </p>
                      {exportState.status === 'loading_insights' && exportState.insightCount !== null && (
                        <p className="text-sm text-muted-foreground">
                          {exportState.totalInsights !== null && exportState.insightCount < exportState.totalInsights
                            ? t('export.usingInsights', {
                              count: exportState.insightCount,
                              total: exportState.totalInsights,
                            })
                            : t('export.insightCount', { count: exportState.insightCount })}
                        </p>
                      )}
                      {exportState.status === 'synthesizing' && (
                        <p className="text-sm text-muted-foreground">
                          {t('export.waitHint')}
                        </p>
                      )}
                    </div>
                  </>
                )}

                {isComplete && (
                  <>
                    <div className="h-8 w-8 rounded-full bg-green-500/15 flex items-center justify-center">
                      <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
                    </div>
                    <div className="space-y-1">
                      <p className="font-medium">{t('export.generationComplete')}</p>
                      <p className="text-sm text-muted-foreground">
                        {t('export.synthesizedCount', {
                          count: exportState.metadata?.insightCount ?? 0,
                        })}
                      </p>
                    </div>
                  </>
                )}

                {isError && (
                  <>
                    <div className="h-8 w-8 rounded-full bg-destructive/15 flex items-center justify-center">
                      <span className="text-destructive font-bold text-sm">!</span>
                    </div>
                    <div className="space-y-1">
                      <p className="font-medium text-destructive">{t('export.generationFailed')}</p>
                      <p className="text-sm text-muted-foreground">{exportState.error}</p>
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-between">
            {(exportState.status === 'loading_insights' || exportState.status === 'synthesizing') && (
              <>
                <Button variant="outline" onClick={handleCancelGeneration}>
                  {t('export.cancel')}
                </Button>
                <span />
              </>
            )}
            {isComplete && (
              <>
                <Button variant="outline" onClick={handleCancelGeneration}>
                  {t('export.back')}
                </Button>
                <Button onClick={handleGoToReview}>
                  {t('export.reviewExport')}
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </>
            )}
            {isError && (
              <>
                <Button variant="outline" onClick={handleCancelGeneration}>
                  {t('export.back')}
                </Button>
                <Button onClick={handleStartGeneration}>
                  {t('export.tryAgain')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Step 4: Review & Export ── */}
      {step === 4 && exportState.content !== null && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle className="text-base">{t('export.generatedExport')}</CardTitle>
                  <CardDescription>
                    {exportState.metadata && (
                      t('export.metadata', {
                        sessions: exportState.metadata.sessionCount,
                        insights: exportState.metadata.insightCount,
                        total: exportState.metadata.totalInsights,
                      })
                    )}
                  </CardDescription>
                </div>
                <Badge variant="outline">{getFilename()}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <pre className="rounded-lg bg-muted p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-[32rem] overflow-y-auto">
                {exportState.content}
              </pre>
            </CardContent>
          </Card>

          <div className="flex justify-between flex-wrap gap-2">
            <Button variant="outline" onClick={handleStartOver}>
              {t('export.startOver')}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleCopy}>
                {copied ? (
                  <>
                    <Check className="mr-2 h-4 w-4" />
                    {t('export.copied')}
                  </>
                ) : (
                  <>
                    <Copy className="mr-2 h-4 w-4" />
                    {t('export.copy')}
                  </>
                )}
              </Button>
              <Button onClick={handleDownload}>
                <Download className="mr-2 h-4 w-4" />
                {t('export.downloadMarkdown')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Shared card component ────────────────────────────────────────────────────

function ExportTypeCard({
  icon: Icon,
  title,
  description,
  selected,
  onSelect,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 ${
        selected ? 'border-primary bg-primary/5' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`h-5 w-5 ${selected ? 'text-primary' : 'text-muted-foreground'}`} />
        <span className="font-medium text-sm">{title}</span>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </button>
  );
}
