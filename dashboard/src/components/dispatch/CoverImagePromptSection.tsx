import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Sparkles, Loader2, AlertCircle, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { generateDispatchImagePrompt } from '@/lib/api';
import { useLocale } from '@/i18n/LocaleProvider';
import type { DispatchFormat } from '@/lib/api';

interface CoverImagePromptSectionProps {
  title: string;
  tags: string[];
  tldr: string;
  format: DispatchFormat;
}

export function CoverImagePromptSection({ title, tags, tldr, format }: CoverImagePromptSectionProps) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);

  const mutation = useMutation({
    mutationFn: () => generateDispatchImagePrompt({ title, tags, tldr, format }),
  });

  function handleCopy() {
    if (!mutation.data) return;
    void navigator.clipboard.writeText(mutation.data.prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success(t('dispatch.cover.copiedToast'));
    });
  }

  function handleRegenerate() {
    mutation.reset();
    mutation.mutate();
  }

  return (
    <div className="shrink-0 border-t px-4 py-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('dispatch.cover.title')}</p>

      {!mutation.data && !mutation.isPending && !mutation.isError && (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => mutation.mutate()}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t('dispatch.cover.getPrompt')}
        </Button>
      )}

      {mutation.isPending && (
        <Button variant="outline" size="sm" className="gap-1.5" disabled>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('dispatch.cover.generating')}
        </Button>
      )}

      {mutation.isError && (
        <div className="space-y-2">
          <Alert variant="destructive" className="py-2">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {mutation.error instanceof Error ? mutation.error.message : t('dispatch.cover.generationFailed')}
            </AlertDescription>
          </Alert>
          <Button variant="outline" size="sm" onClick={() => mutation.mutate()}>
            {t('dispatch.cover.retry')}
          </Button>
        </div>
      )}

      {mutation.data && (
        <div className="space-y-2">
          <Textarea
            readOnly
            rows={4}
            value={mutation.data.prompt}
            className="resize-none text-sm"
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleCopy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? t('dispatch.cover.copied') : t('dispatch.cover.copyPrompt')}
            </Button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={handleRegenerate}
            >
              {t('dispatch.cover.regenerate')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
