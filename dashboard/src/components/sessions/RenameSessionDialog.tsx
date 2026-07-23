import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { patchSession } from '@/lib/api';
import { toast } from 'sonner';
import { useLocale } from '@/i18n/LocaleProvider';

interface RenameSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  currentTitle: string;
  onRenamed?: () => void;
}

export function RenameSessionDialog({
  open,
  onOpenChange,
  sessionId,
  currentTitle,
  onRenamed,
}: RenameSessionDialogProps) {
  const { t } = useLocale();
  const [title, setTitle] = useState(currentTitle);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(currentTitle);
    }
  }, [open, currentTitle]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await patchSession(sessionId, { customTitle: title });
      toast.success(t('sessions.rename.success'));
      onRenamed?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sessions.rename.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('sessions.rename.title')}</DialogTitle>
          <DialogDescription>
            {t('sessions.rename.description')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('sessions.rename.placeholder')}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('sessions.rename.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('sessions.rename.saving') : t('sessions.rename.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
