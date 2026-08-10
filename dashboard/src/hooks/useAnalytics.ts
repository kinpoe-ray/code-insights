import { useQuery } from '@tanstack/react-query';
import { fetchAnalyticsOverview, fetchDashboardStats } from '@/lib/api';
import type { AnalyticsRange } from '@/lib/types';

type Range = '7d' | '30d' | '90d' | 'all';

export function useDashboardStats(range: Range = '7d') {
  return useQuery({
    queryKey: ['analytics', 'dashboard', range],
    queryFn: () => fetchDashboardStats(range).then((r) => r.stats),
    refetchInterval: 60_000,
  });
}

export function useAnalyticsOverview(range: AnalyticsRange = '7d', source = 'all') {
  const timezoneOffset = new Date().getTimezoneOffset();
  return useQuery({
    queryKey: ['analytics', 'overview', range, source, timezoneOffset],
    queryFn: () => fetchAnalyticsOverview(range, source, timezoneOffset),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
