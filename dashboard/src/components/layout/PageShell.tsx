import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageShellProps {
  children: ReactNode;
  className?: string;
  size?: 'default' | 'wide';
}

export function PageShell({ children, className, size = 'default' }: PageShellProps) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-8',
        size === 'wide' ? 'max-w-[1600px]' : 'max-w-[1440px]',
        className,
      )}
    >
      {children}
    </div>
  );
}

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, eyebrow, meta, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0 max-w-3xl">
        {eyebrow && (
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-primary">
            {eyebrow}
          </div>
        )}
        <h1 className="text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-[15px]">
            {subtitle}
          </p>
        )}
        {meta && <div className="mt-3">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 sm:justify-end">{actions}</div>}
    </header>
  );
}
