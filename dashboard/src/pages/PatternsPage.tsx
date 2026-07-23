import { useState, useCallback, useRef, useEffect } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useProjects } from '@/hooks/useProjects';
import { useFacetAggregation, useReflectSnapshot, useReflectWeeks } from '@/hooks/useReflect';
import { reflectGenerateStream, fetchOutdatedFacetCount } from '@/lib/api';
import { WeekSelector } from '@/components/patterns/WeekSelector';
import { WeekAtAGlanceStrip } from '@/components/patterns/WeekAtAGlanceStrip';
import { CollapsibleCategoryList } from '@/components/patterns/CollapsibleCategoryList';
import { WorkingStyleHighlights } from '@/components/patterns/WorkingStyleHighlights';
import { getCurrentIsoWeek } from '@/lib/date-utils';
import { parseSSEStream } from '@/lib/sse';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ErrorCard } from '@/components/ErrorCard';
import { frictionBarColor, getDominantDriver } from '@/lib/constants/patterns';
import {
  AlertTriangle, Sparkles, Shield, Brain, Copy, Check, Loader2,
} from 'lucide-react';
import { LlmNudgeBanner } from '@/components/LlmNudgeBanner';
import { useLocale } from '@/i18n/LocaleProvider';

export default function PatternsPage() {
  const { t, formatNumber, formatRelativeDate } = useLocale();
  const [currentWeek, setCurrentWeek] = useState<string>(() => getCurrentIsoWeek());
  const [selectedProject, setSelectedProject] = useState<string | undefined>(undefined);
  const [generating, setGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState('');
  const [reflectResults, setReflectResults] = useState<Record<string, unknown> | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();

  const { data: projects = [] } = useProjects();

  const { data: weeksData } = useReflectWeeks({ project: selectedProject });
  const weeks = weeksData?.weeks ?? [];

  const { data: snapshotData } = useReflectSnapshot({
    period: currentWeek,
    project: selectedProject,
  });

  const { data: aggregation, isLoading, isError, refetch } = useFacetAggregation({
    period: currentWeek,
    project: selectedProject,
  });

  const { data: outdatedData } = useQuery({
    queryKey: ['facets', 'outdated', selectedProject, currentWeek],
    queryFn: () => fetchOutdatedFacetCount({ project: selectedProject, period: currentWeek }),
    staleTime: 5 * 60 * 1000,
  });

  const outdatedCount = outdatedData?.count ?? 0;

  // Abort in-flight generation on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // On initial load, jump to the most recent week that has a snapshot.
  // This avoids showing the current week with no data when reflections exist for recent weeks.
  // Only runs once (when weeks first loads) — tracked by whether currentWeek is still the computed default.
  const initialWeekRef = useRef<string>(getCurrentIsoWeek());
  useEffect(() => {
    if (!weeksData?.weeks.length) return;
    if (currentWeek !== initialWeekRef.current) return; // user already navigated
    const mostRecentWithSnapshot = weeksData.weeks.find(w => w.hasSnapshot);
    if (mostRecentWithSnapshot && mostRecentWithSnapshot.week !== currentWeek) {
      handleWeekChange(mostRecentWithSnapshot.week);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // Intentional: handleWeekChange is stable (useCallback with no deps) and initialWeekRef
  // is a ref — neither should trigger re-runs. Re-running on every render would break the
  // "jump to most recent snapshot only on initial load" logic.
  }, [weeksData]);

  // Auto-load cached snapshot when it arrives and no local results exist yet
  useEffect(() => {
    if (snapshotData?.snapshot?.results && !reflectResults && !generating) {
      setReflectResults(snapshotData.snapshot.results);
    }
  }, [snapshotData, reflectResults, generating]);

  const handleWeekChange = useCallback((week: string) => {
    setCurrentWeek(week);
    setReflectResults(null);
  }, []);

  const handleProjectChange = useCallback((projectId: string | undefined) => {
    setSelectedProject(projectId);
    setReflectResults(null);
    // Reset to current week so auto-navigation re-fires for the new project context.
    // The initialWeekRef guard in the auto-navigate effect uses getCurrentIsoWeek(),
    // so resetting currentWeek to that value re-enables the "jump to most recent snapshot" logic.
    setCurrentWeek(getCurrentIsoWeek());
    initialWeekRef.current = getCurrentIsoWeek();
  }, []);

  const handleGenerate = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setGenerating(true);
    setGenerationProgress(t('patterns.starting'));
    setReflectResults(null);

    try {
      const response = await reflectGenerateStream(
        { period: currentWeek, project: selectedProject },
        controller.signal
      );

      if (!response.body) throw new Error(t('patterns.noResponseBody'));

      for await (const event of parseSSEStream(response.body)) {
        if (event.event === 'progress') {
          try {
            const data = JSON.parse(event.data) as { phase?: string; section?: string; message?: string };
            if (data.phase === 'aggregating') {
              setGenerationProgress(t('patterns.aggregating'));
            } else if (data.phase === 'synthesizing' && data.section) {
              const section = data.section === 'friction-wins'
                ? t('patterns.section.friction-wins')
                : data.section === 'rules-skills'
                  ? t('patterns.section.rules-skills')
                  : data.section === 'working-style'
                    ? t('patterns.section.working-style')
                    : data.section;
              setGenerationProgress(t('patterns.generatingSection', { section }));
            } else {
              setGenerationProgress(data.message || t('patterns.processing'));
            }
          } catch { /* skip malformed event */ }
        } else if (event.event === 'complete') {
          try {
            const data = JSON.parse(event.data) as { results?: Record<string, unknown> };
            setReflectResults(data.results ?? null);
            queryClient.invalidateQueries({ queryKey: ['reflect', 'snapshot'] });
          } catch { /* skip malformed event */ }
        } else if (event.event === 'error') {
          try {
            const data = JSON.parse(event.data) as { error?: string };
            setGenerationProgress(t('patterns.errorPrefix', {
              error: data.error ?? t('patterns.unknownError'),
            }));
          } catch { /* skip malformed event */ }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setGenerationProgress(err instanceof Error ? err.message : t('patterns.generationFailed'));
    } finally {
      setGenerating(false);
    }
  }, [currentWeek, selectedProject, queryClient, t]);

  const handleCopy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-6 p-4 lg:p-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4 lg:p-6">
        <ErrorCard message={t('patterns.loadError')} onRetry={refetch} />
      </div>
    );
  }

  // --- Derived data ---

  const frictionItems = (aggregation?.frictionCategories || []).slice(0, 10).map(fc => ({
    category: fc.category,
    count: fc.count,
    severity: Math.round(fc.avg_severity * 10) / 10,
    color: frictionBarColor(fc.avg_severity),
    descriptions: fc.examples,
  }));

  const patternItems = (aggregation?.effectivePatterns || []).slice(0, 8).map(ep => ({
    category: ep.label,
    count: ep.frequency,
    descriptions: ep.descriptions,
    driver: getDominantDriver(ep.drivers),
  }));

  const hasEnoughFacets = (aggregation?.totalSessions ?? 0) >= 8;
  const coverageRatio = aggregation && aggregation.totalAllSessions > 0
    ? aggregation.totalSessions / aggregation.totalAllSessions
    : 0;

  const rulesSkillsResult = reflectResults?.['rules-skills'] as Record<string, unknown> | undefined;
  const workingStyleResult = reflectResults?.['working-style'] as Record<string, unknown> | undefined;

  const tagline = workingStyleResult?.tagline as string | undefined;
  const taglineSubtitle = workingStyleResult?.tagline_subtitle as string | undefined;
  const narrative = workingStyleResult?.narrative as string | undefined;

  // Derive working style highlights from aggregation data
  // DB stores outcome_satisfaction as 'high' | 'medium' | 'low' | 'abandoned' — NOT 'success'
  const successCount = aggregation?.outcomeDistribution?.['high'] ?? 0;

  const topCharacterEntry = aggregation?.characterDistribution
    ? Object.entries(aggregation.characterDistribution).sort((a, b) => b[1] - a[1])[0]
    : null;
  const totalCharacters = aggregation?.characterDistribution
    ? Object.values(aggregation.characterDistribution).reduce((s, v) => s + v, 0)
    : 0;
  const topCharacter = topCharacterEntry && totalCharacters > 0
    ? { name: topCharacterEntry[0], percentage: Math.round((topCharacterEntry[1] / totalCharacters) * 100) }
    : undefined;

  const topFrictionEntry = frictionItems[0];
  const topFriction = topFrictionEntry
    ? { category: topFrictionEntry.category, count: topFrictionEntry.count }
    : undefined;

  const topPatternEntry = patternItems[0];
  const topPattern = topPatternEntry
    ? { label: topPatternEntry.category, frequency: topPatternEntry.count }
    : undefined;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <LlmNudgeBanner context="patterns" />
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('patterns.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('patterns.subtitle')}
          </p>
          {/* Snapshot metadata line — shown when a reflection exists for this week */}
          {snapshotData?.snapshot && reflectResults && (
            <p className="text-xs text-muted-foreground mt-1">
              {t('patterns.generated', { date: formatRelativeDate(snapshotData.snapshot.generatedAt) })}
              {' · '}
              {t('patterns.sessionsAnalyzed', { count: formatNumber(snapshotData.snapshot.sessionCount) })}
              {aggregation && aggregation.totalSessions > snapshotData.snapshot.sessionCount && (
                <> — <span className="text-amber-500">{t('patterns.newSince', { count: formatNumber(aggregation.totalSessions - snapshotData.snapshot.sessionCount) })}</span></>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          {/* Week selector */}
          <WeekSelector
            currentWeek={currentWeek}
            weeks={weeks}
            onWeekChange={handleWeekChange}
          />
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {projects.length > 1 && (
              <select
                value={selectedProject || ''}
                onChange={(e) => handleProjectChange(e.target.value || undefined)}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                <option value="">{t('patterns.allProjects')}</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
            <Button
              onClick={handleGenerate}
              disabled={generating || !hasEnoughFacets}
              size="sm"
            >
              {generating ? (
                <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />{t('patterns.generating')}</>
              ) : reflectResults ? (
                <><Sparkles className="h-4 w-4 mr-1.5" />{t('patterns.regenerate')}</>
              ) : (
                <><Sparkles className="h-4 w-4 mr-1.5" />{t('patterns.generate')}</>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Threshold gate */}
      {!hasEnoughFacets && aggregation && (
        <div className="flex items-start gap-3 rounded-lg border border-muted bg-muted/30 p-3">
          <AlertTriangle className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            {aggregation.totalAllSessions === 0 ? (
              <>
                <p className="text-sm font-medium">{t('patterns.noSessionsWeek')}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('patterns.navigateWeek')}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">
                  {t('patterns.notEnoughAnalyzed')}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('patterns.needSessions', { count: formatNumber(aggregation.totalSessions) })}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Coverage warning */}
      {hasEnoughFacets && coverageRatio > 0 && coverageRatio < 0.5 && aggregation && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 p-3">
          <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">
              {t('patterns.coverage', {
                analyzed: formatNumber(aggregation.totalSessions),
                total: formatNumber(aggregation.totalAllSessions),
              })}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t('patterns.coverageHelp')}
            </p>
          </div>
        </div>
      )}

      {/* Outdated sessions alert — page-level so it's visible regardless of active tab */}
      {outdatedCount > 0 && (
        <Alert className="border-amber-500/30 bg-amber-50 dark:bg-amber-950/20">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <AlertDescription className="text-xs text-amber-700 dark:text-amber-300">
            {t('patterns.outdatedSessions', {
              count: formatNumber(outdatedCount),
              verb: outdatedCount === 1 ? 'has' : 'have',
            })}
          </AlertDescription>
        </Alert>
      )}

      {/* Generation progress */}
      {generating && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{generationProgress}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Week hero card — richer summary with stats, character distribution, streak, and outcomes */}
      <WeekAtAGlanceStrip
        tagline={tagline}
        taglineSubtitle={taglineSubtitle}
        totalSessions={aggregation?.totalSessions ?? 0}
        totalAllSessions={aggregation?.totalAllSessions ?? 0}
        outcomeDistribution={aggregation?.outcomeDistribution ?? {}}
        hasGenerated={!!reflectResults}
        characterDistribution={aggregation?.characterDistribution}
        streak={aggregation?.streak}
        rateLimitCount={aggregation?.rateLimitInfo?.count}
        rateLimitSessionsAffected={aggregation?.rateLimitInfo?.sessionsAffected}
        sourceTools={aggregation?.sourceTools}
        currentWeek={currentWeek}
        pqScores={aggregation?.pqScores}
        lifetimeSessions={aggregation?.lifetimeSessions}
        totalTokens={aggregation?.totalTokens}
        effectivePatterns={aggregation?.effectivePatterns?.slice(0, 3).map(ep => ({ label: ep.label, frequency: ep.frequency }))}
      />

      {/* 2-tab layout */}
      <Tabs defaultValue="insights">
        <TabsList variant="line" className="w-full justify-start border-b rounded-none px-0 h-auto pb-0">
          <TabsTrigger
            value="insights"
            className="flex items-center gap-1.5 pb-2.5 data-[state=active]:after:bg-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400"
          >
            <Brain className="h-4 w-4" />
            {t('patterns.insightsTab')}
          </TabsTrigger>
          <TabsTrigger
            value="artifacts"
            className="flex items-center gap-1.5 pb-2.5 data-[state=active]:after:bg-violet-500 data-[state=active]:text-violet-600 dark:data-[state=active]:text-violet-400"
          >
            <Shield className="h-4 w-4" />
            {t('patterns.artifactsTab')}
          </TabsTrigger>
        </TabsList>

        {/* INSIGHTS TAB */}
        <TabsContent value="insights" className="mt-4 space-y-4">
          {/* Working style summary — borderless content, no Card wrapper */}
          {(reflectResults || (aggregation?.totalSessions ?? 0) > 0) && (
            <WorkingStyleHighlights
              narrative={narrative}
              totalSessions={aggregation?.totalSessions ?? 0}
              successCount={successCount}
              topCharacter={topCharacter}
              topFriction={topFriction}
              topPattern={topPattern}
            />
          )}

          {/* Friction + Patterns — 50/50 grid */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Friction Points — red left accent */}
            <Card className="border-l-2 border-red-400 dark:border-red-500">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />
                  {t('patterns.frictionTitle')}
                </CardTitle>
                <CardDescription>{t('patterns.frictionDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                {frictionItems.length > 0 ? (
                  <CollapsibleCategoryList items={frictionItems} variant="friction" />
                ) : (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    {t('patterns.noFriction')}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Effective Patterns — emerald left accent */}
            <Card className="border-l-2 border-emerald-400 dark:border-emerald-500">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-emerald-500 shrink-0" />
                  {t('patterns.effectiveTitle')}
                </CardTitle>
                <CardDescription>{t('patterns.effectiveDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                {patternItems.length > 0 ? (
                  <CollapsibleCategoryList items={patternItems} variant="pattern" />
                ) : (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    {t('patterns.noEffective')}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ARTIFACTS TAB */}
        <TabsContent value="artifacts" className="mt-4 space-y-4">
          {rulesSkillsResult ? (
            <>
              {/* CLAUDE.md Rules */}
              {Array.isArray(rulesSkillsResult.claudeMdRules) && (rulesSkillsResult.claudeMdRules as Array<{ rule: string; rationale: string; frictionSource: string }>).length > 0 && (
                <Card className="border-l-2 border-primary">
                  <CardHeader>
                    <CardTitle className="text-base">{t('patterns.rulesTitle')}</CardTitle>
                    <CardDescription>{t('patterns.rulesDescription')}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {(rulesSkillsResult.claudeMdRules as Array<{ rule: string; rationale: string; frictionSource: string }>).map((r, i) => (
                      <div key={i} className="rounded-lg border p-3">
                        <div className="flex items-start justify-between gap-2">
                          <code className="text-sm font-mono flex-1">{r.rule}</code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => handleCopy(r.rule, `rule-${i}`)}
                            aria-label={copiedKey === `rule-${i}` ? t('patterns.copied') : t('patterns.copy')}
                          >
                            {copiedKey === `rule-${i}` ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">{r.rationale}</p>
                        <div className="mt-2">
                          <Badge variant="secondary" className="text-xs">{r.frictionSource}</Badge>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Hook Configurations */}
              {Array.isArray(rulesSkillsResult.hookConfigs) && (rulesSkillsResult.hookConfigs as Array<{ event: string; command: string; rationale: string }>).length > 0 && (
                <Card className="border-l-2 border-primary">
                  <CardHeader>
                    <CardTitle className="text-base">{t('patterns.hooksTitle')}</CardTitle>
                    <CardDescription>{t('patterns.hooksDescription')}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {(rulesSkillsResult.hookConfigs as Array<{ event: string; command: string; rationale: string }>).map((h, i) => (
                      <div key={i} className="rounded-lg border p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{h.event}</span>
                            <code className="block text-sm font-mono mt-2">{h.command}</code>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => handleCopy(h.command, `hook-${i}`)}
                            aria-label={copiedKey === `hook-${i}` ? t('patterns.copied') : t('patterns.copy')}
                          >
                            {copiedKey === `hook-${i}` ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">{h.rationale}</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          ) : (
            /* Pattern Ingredients fallback — before generation */
            aggregation && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('patterns.ingredientsTitle')}</CardTitle>
                  <CardDescription>
                    {hasEnoughFacets
                      ? t('patterns.ingredientsReady')
                      : t('patterns.ingredientsLocked')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {aggregation.frictionCategories.filter(fc => fc.count >= 3).length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">{t('patterns.recurringFriction')}</p>
                      <ul className="space-y-1">
                        {aggregation.frictionCategories.filter(fc => fc.count >= 3).map((fc, i) => (
                          <li key={i} className="text-sm flex items-center gap-2">
                            <span className="text-xs font-mono text-muted-foreground">{t('patterns.times', { count: formatNumber(fc.count) })}</span>
                            {fc.category}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {aggregation.effectivePatterns.filter(ep => ep.frequency >= 2).length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">{t('patterns.recurringEffective')}</p>
                      <ul className="space-y-1">
                        {aggregation.effectivePatterns.filter(ep => ep.frequency >= 2).map((ep, i) => (
                          <li key={i} className="text-sm flex items-center gap-2">
                            <span className="text-xs font-mono text-muted-foreground">{t('patterns.times', { count: formatNumber(ep.frequency) })}</span>
                            {ep.label}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {aggregation.frictionCategories.filter(fc => fc.count >= 3).length === 0 &&
                   aggregation.effectivePatterns.filter(ep => ep.frequency >= 2).length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {t('patterns.noRecurring')}
                    </p>
                  )}
                </CardContent>
              </Card>
            )
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
