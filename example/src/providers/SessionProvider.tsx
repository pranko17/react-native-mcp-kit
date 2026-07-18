import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useMcpTool } from 'react-native-mcp-kit';

export interface SessionUser {
  name: string;
  email: string;
}

interface SessionValue {
  user: SessionUser | null;
  login: (name: string) => void;
  logout: () => void;
}

const SessionContext = createContext<SessionValue>({
  user: null,
  login: () => {},
  logout: () => {},
});

export const useSession = (): SessionValue => useContext(SessionContext);

// Demonstrates `useMcpTool` — ad-hoc tools tied to a component's lifecycle.
// They register as `__dynamic__session_login` / `__dynamic__session_logout`
// and show up in `list_tools` under "(dynamic)".
export const SessionProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [user, setUser] = useState<SessionUser | null>(null);

  const login = useCallback((name: string) => {
    const clean = name.trim() || 'Ada';
    setUser({ name: clean, email: `${clean.toLowerCase().replace(/\s+/g, '.')}@example.com` });
  }, []);

  const logout = useCallback(() => setUser(null), []);

  useMcpTool(
    'session_login',
    () => ({
      description: 'Log a demo user into the in-app session by name.',
      inputSchema: { name: { type: 'string' } },
      handler: async (args) => {
        const name = String(args.name ?? 'Ada');
        login(name);
        return { loggedIn: true, name };
      },
    }),
    [login]
  );

  useMcpTool(
    'session_logout',
    () => ({
      description: 'Log the current demo user out of the in-app session.',
      handler: async () => {
        logout();
        return { loggedIn: false };
      },
    }),
    [logout]
  );

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};
