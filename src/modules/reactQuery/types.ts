export interface QueryClientLike {
  getQueryCache: () => {
    getAll: () => Array<{
      queryHash: string;
      queryKey: readonly unknown[];
      state: {
        dataUpdatedAt: number;
        errorUpdatedAt: number;
        fetchStatus: string;
        status: string;
        data?: unknown;
        error?: unknown;
      };
    }>;
  };
  invalidateQueries: (filters?: { queryKey?: readonly unknown[] }) => Promise<void>;
  refetchQueries: (filters?: { queryKey?: readonly unknown[] }) => Promise<void>;
  removeQueries: (filters?: { queryKey?: readonly unknown[] }) => void;
  resetQueries: (filters?: { queryKey?: readonly unknown[] }) => Promise<void>;
}
