import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useMcpModule } from 'react-native-mcp-kit';

export interface FeatureFlags {
  newCheckout: boolean;
  betaBanner: boolean;
  verboseLogging: boolean;
}

interface FlagsValue {
  flags: FeatureFlags;
  setFlag: (key: keyof FeatureFlags, value: boolean) => void;
}

const defaults: FeatureFlags = {
  newCheckout: true,
  betaBanner: false,
  verboseLogging: false,
};

const FeatureFlagsContext = createContext<FlagsValue>({
  flags: defaults,
  setFlag: () => {},
});

export const useFeatureFlags = (): FlagsValue => useContext(FeatureFlagsContext);

// Demonstrates `useMcpModule` — registering a whole module from a feature
// subtree rather than via provider props. Re-binds whenever `flags` changes so
// `feature_flags__get_flags` always reflects the latest values.
export const FeatureFlagsProvider = ({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element => {
  const [flags, setFlags] = useState<FeatureFlags>(defaults);

  const setFlag = useCallback((key: keyof FeatureFlags, value: boolean) => {
    setFlags((prev) => ({ ...prev, [key]: value }));
  }, []);

  useMcpModule(
    () => ({
      name: 'feature_flags',
      description:
        'Runtime feature flags owned by a feature subtree, registered via useMcpModule.',
      tools: {
        get_flags: {
          description: 'Return all feature flags and their current values.',
          handler: async () => ({ ...flags }),
        },
        set_flag: {
          description: 'Toggle a feature flag on or off.',
          inputSchema: {
            key: { type: 'string' },
            value: { type: 'boolean' },
          },
          handler: async (args) => {
            const key = String(args.key) as keyof FeatureFlags;
            if (!(key in flags)) {
              return { error: `Unknown flag "${key}"`, known: Object.keys(flags) };
            }
            setFlag(key, Boolean(args.value));
            return { ok: true, key, value: Boolean(args.value) };
          },
        },
      },
    }),
    [flags, setFlag]
  );

  const value = useMemo(() => ({ flags, setFlag }), [flags, setFlag]);

  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
};
