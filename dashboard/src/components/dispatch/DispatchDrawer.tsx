import { useState, useCallback, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Loader2, AlertCircle, X } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { generateDispatch } from '@/lib/api';
import { useLocale } from '@/i18n/LocaleProvider';
import { PostOverlay } from './PostOverlay';
import type { Insight, DispatchPrefill } from '@/lib/types';
import type { DispatchTone, DispatchFormat, DispatchResponse } from '@/lib/api';

const INSIGHT_TYPE_COLORS: Record<string, string> = {
  learning: 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20',
  decision: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20',
  technique: 'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20',
  summary: 'bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/20',
  prompt_quality: 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20',
};

interface SortableInsightItemProps {
  insight: Insight;
  onRemove: (id: string) => void;
}

function SortableInsightItem({ insight, onRemove }: SortableInsightItemProps) {
  const { t } = useLocale();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: insight.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const colorClass = INSIGHT_TYPE_COLORS[insight.type] ?? INSIGHT_TYPE_COLORS.summary;
  const typeLabel = {
    learning: t('dispatch.insightType.learning'),
    decision: t('dispatch.insightType.decision'),
    technique: t('dispatch.insightType.technique'),
    summary: t('dispatch.insightType.summary'),
    prompt_quality: t('dispatch.insightType.promptQuality'),
  }[insight.type] ?? insight.type.replace('_', ' ');

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-start gap-2 rounded-md border bg-card p-2.5 text-sm"
    >
      <button
        className="mt-0.5 shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
        aria-label={t('dispatch.dragAria')}
        aria-describedby="drag-hint"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1">
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${colorClass}`}>
            {typeLabel}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{insight.summary || insight.title}</p>
      </div>
      <button
        className="shrink-0 text-muted-foreground hover:text-destructive transition-colors mt-0.5"
        onClick={() => onRemove(insight.id)}
        aria-label={t('dispatch.removeAria')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface DispatchDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedInsights: Insight[];
  onReorder: (insights: Insight[]) => void;
  onRemove: (id: string) => void;
  prefill?: DispatchPrefill;
}

export function DispatchDrawer({
  open,
  onOpenChange,
  selectedInsights,
  onReorder,
  onRemove,
  prefill,
}: DispatchDrawerProps) {
  const { t } = useLocale();
  const [context, setContext] = useState('');
  const [contextEdited, setContextEdited] = useState(false);
  const [format, setFormat] = useState<DispatchFormat>('blog');
  const [tone, setTone] = useState<DispatchTone>('technical');
  const [includeSessionBackground, setIncludeSessionBackground] = useState(false);
  const [result, setResult] = useState<DispatchResponse | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);

  // When drawer opens with a prefill, apply it; when closed, reset transient state
  useEffect(() => {
    if (open && prefill) {
      setContext(prefill.contextMarkdown);
      setContextEdited(false);
      setFormat(prefill.format);
    }
    if (!open) {
      setContext('');
      setContextEdited(false);
    }
  }, [open, prefill]);

  const mutation = useMutation({
    mutationFn: generateDispatch,
    onSuccess: (data) => { setResult(data); setOverlayOpen(true); },
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = selectedInsights.findIndex((i) => i.id === active.id);
    const newIndex = selectedInsights.findIndex((i) => i.id === over.id);
    onReorder(arrayMove(selectedInsights, oldIndex, newIndex));
  }, [selectedInsights, onReorder]);

  function handleGenerate() {
    mutation.mutate({
      insightIds: selectedInsights.map((i) => i.id),
      context,
      tone,
      format,
      includeSessionBackground,
    });
  }

  function handleClose() {
    onOpenChange(false);
    setOverlayOpen(false);
    setResult(null);
    mutation.reset();
    setFormat('blog');
    setTone('technical');
    setContext('');
    setContextEdited(false);
    setIncludeSessionBackground(false);
  }

  const canGenerate = selectedInsights.length >= 3 && context.trim().length > 0 && !mutation.isPending;
  const contextTooLong = context.length > 500;
  const formatOptions: { value: DispatchFormat; label: string; description: string }[] = [
    { value: 'blog', label: t('dispatch.format.blog'), description: t('dispatch.format.blogDescription') },
    { value: 'linkedin', label: t('dispatch.format.linkedin'), description: t('dispatch.format.linkedinDescription') },
  ];
  const toneOptions: { value: DispatchTone; label: string; description: string }[] = [
    { value: 'technical', label: t('dispatch.tone.technical'), description: t('dispatch.tone.technicalDescription') },
    { value: 'accessible', label: t('dispatch.tone.accessible'), description: t('dispatch.tone.accessibleDescription') },
    { value: 'quick-tips', label: t('dispatch.tone.quickTips'), description: t('dispatch.tone.quickTipsDescription') },
  ];

  return (
    <>
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-none sm:w-[480px] flex flex-col p-0 gap-0"
      >
        <SheetHeader className="px-4 py-3 border-b shrink-0">
          <SheetTitle>{t('dispatch.createPost')}</SheetTitle>
          <SheetDescription>
            {prefill
              ? t('dispatch.drawer.draftingFrom', { title: prefill.title })
              : t('dispatch.drawer.description')}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {/* Selected insights with drag-to-reorder */}
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                {t('dispatch.selected', { count: selectedInsights.length })}
                {selectedInsights.length > 0 && (
                  <span className="ml-1 normal-case font-normal">{t('dispatch.dragToReorder')}</span>
                )}
              </p>
              <span id="drag-hint" className="sr-only">
                {t('dispatch.dragHint')}
              </span>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={selectedInsights.map((i) => i.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1.5">
                    {selectedInsights.map((insight) => (
                      <SortableInsightItem
                        key={insight.id}
                        insight={insight}
                        onRemove={onRemove}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
              {selectedInsights.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {t('dispatch.noSelection')}
                </p>
              )}
            </div>

            {/* Context textarea */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                {t('dispatch.story')}
              </label>
              <Textarea
                rows={4}
                maxLength={500}
                placeholder={t('dispatch.storyPlaceholder')}
                value={context}
                onChange={(e) => { setContext(e.target.value); if (prefill) setContextEdited(true); }}
                className="resize-none"
              />
              <div className="flex justify-between mt-1">
                <p className="text-xs text-muted-foreground">
                  {t('dispatch.storyHint')}
                </p>
                <span className={`text-xs ${contextTooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {context.length}/500
                </span>
              </div>
              {prefill && contextEdited && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-7 text-xs text-muted-foreground"
                  onClick={() => { setContext(prefill.contextMarkdown); setContextEdited(false); }}
                >
                  {t('dispatch.resetDefaults')}
                </Button>
              )}
            </div>

            {/* Format selector */}
            <fieldset className="space-y-2 border-0 p-0 m-0 min-w-0">
              <legend className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('dispatch.format')}</legend>
              <div className="space-y-1.5">
                {formatOptions.map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 cursor-pointer transition-colors ${
                      format === opt.value
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <input
                      type="radio"
                      name="dispatch-format"
                      value={opt.value}
                      checked={format === opt.value}
                      onChange={() => setFormat(opt.value)}
                      className="mt-0.5 shrink-0 accent-primary"
                    />
                    <div>
                      <p className="text-sm font-medium">{opt.label}</p>
                      <p className="text-xs text-muted-foreground">{opt.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Tone selector */}
            <fieldset className="space-y-2 border-0 p-0 m-0 min-w-0">
              <legend className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('dispatch.tone')}</legend>
              <div className="space-y-1.5">
                {toneOptions.map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 cursor-pointer transition-colors ${
                      tone === opt.value
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <input
                      type="radio"
                      name="dispatch-tone"
                      value={opt.value}
                      checked={tone === opt.value}
                      onChange={() => setTone(opt.value)}
                      className="mt-0.5 shrink-0 accent-primary"
                    />
                    <div>
                      <p className="text-sm font-medium">{opt.label}</p>
                      <p className="text-xs text-muted-foreground">{opt.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Session background toggle */}
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div className="space-y-0.5">
                <label htmlFor="session-background" className="text-sm font-medium cursor-pointer">
                  {t('dispatch.includeSessionBackground')}
                </label>
                <p id="session-bg-desc" className="text-xs text-muted-foreground">
                  {t('dispatch.includeSessionBackgroundDescription')}
                </p>
              </div>
              <Switch
                id="session-background"
                checked={includeSessionBackground}
                onCheckedChange={setIncludeSessionBackground}
                aria-describedby="session-bg-desc"
              />
            </div>

            {/* Error */}
            {mutation.isError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{mutation.error instanceof Error ? mutation.error.message : t('dispatch.generationFailed')}</span>
              </div>
            )}
          </div>

        {/* Footer */}
        {!result ? (
          <div className="shrink-0 px-4 py-3 border-t">
            <Button
              className="w-full"
              onClick={handleGenerate}
              disabled={!canGenerate || contextTooLong}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('dispatch.generating')}
                </>
              ) : (
                t('dispatch.generatePost')
              )}
            </Button>
            {!context.trim() && selectedInsights.length >= 3 && (
              <p className="text-xs text-muted-foreground text-center mt-1.5">
                {t('dispatch.contextRequired')}
              </p>
            )}
          </div>
        ) : (
          <div className="shrink-0 px-4 py-3 border-t flex gap-2">
            <Button
              className="flex-1"
              onClick={() => setOverlayOpen(true)}
            >
              {t('dispatch.viewPost')}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => { setResult(null); mutation.reset(); }}
            >
              {t('dispatch.regenerate')}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>

    {result && (
      <PostOverlay
        open={overlayOpen}
        onClose={() => setOverlayOpen(false)}
        result={result}
      />
    )}
    </>
  );
}
