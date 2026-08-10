import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchInsights, deleteInsight } from '@/lib/api';

interface InsightParams {
  projectId?: string;
  sessionId?: string;
  type?: string;
  sourceTool?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export function useInsights(params?: InsightParams) {
  return useQuery({
    queryKey: ['insights', params],
    queryFn: () => fetchInsights(params).then((r) => r.insights),
  });
}

export function useInsightSearch(
  params?: Omit<InsightParams, 'limit' | 'offset'>,
  pageSize = 120,
) {
  return useInfiniteQuery({
    queryKey: ['insights', 'search', params, pageSize],
    queryFn: ({ pageParam }) => fetchInsights({
      ...params,
      limit: pageSize,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.insights.length;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
  });
}

export function useDeleteInsight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteInsight(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['insights'] });
    },
  });
}
