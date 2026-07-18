import { QueryClient } from '@tanstack/react-query';

// One QueryClient for the whole app. Passed to both `<QueryClientProvider>`
// (so hooks work) and `<McpProvider queryClient={…} />` (so the agent gets
// `query__list`, `query__get_data`, `query__mutate`, …).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});
