import { type ComponentType, createElement, useEffect, useMemo, useRef } from 'react';

import { McpClient } from '@/client/core/McpClient';
import { alertModule } from '@/modules/alert';
import { consoleModule } from '@/modules/console';
import { deviceModule } from '@/modules/device';
import { errorsModule } from '@/modules/errors';
import { fiberTreeModule } from '@/modules/fiberTree';
import { i18nextModule } from '@/modules/i18next';
import { navigationModule } from '@/modules/navigation';
import { networkModule } from '@/modules/network';
import { reactQueryModule } from '@/modules/reactQuery';
import { storageModule } from '@/modules/storage';

import { McpContext } from './McpContext';
import { type McpContextValue, type McpProviderProps } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

// Lazy-require so importing this file from Node (e.g. the server entry) does
// not pull react-native into scope. Matches the pattern used elsewhere in the
// library (see device/alert modules).
let ViewComponent: AnyComponent | undefined;
const getView = (): AnyComponent => {
  if (!ViewComponent) {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    ViewComponent = require('react-native').View as AnyComponent;
  }
  return ViewComponent;
};

export const McpProvider = ({
  children,
  debug,
  i18n,
  modules,
  navigationRef,
  queryClient,
  storages,
}: McpProviderProps) => {
  const client = useMemo(() => {
    return McpClient.initialize({ debug });
  }, [debug]);

  const rootRef = useRef<unknown>(null);

  // Always-on modules — fiberTree picks up the internal root ref so apps no
  // longer need to manage one manually.
  useEffect(() => {
    client.registerModules([
      alertModule(),
      consoleModule(),
      deviceModule(),
      errorsModule(),
      networkModule(),
      fiberTreeModule({ rootRef }),
    ]);
  }, [client]);

  useEffect(() => {
    if (!navigationRef) return;
    client.registerModule(navigationModule(navigationRef));
  }, [client, navigationRef]);

  useEffect(() => {
    if (!queryClient) return;
    client.registerModule(reactQueryModule(queryClient));
  }, [client, queryClient]);

  useEffect(() => {
    if (!i18n) return;
    client.registerModule(i18nextModule(i18n));
  }, [client, i18n]);

  useEffect(() => {
    if (!storages || storages.length === 0) return;
    client.registerModule(storageModule(...storages));
  }, [client, storages]);

  useEffect(() => {
    if (!modules || modules.length === 0) return;
    client.registerModules(modules);
  }, [client, modules]);

  const contextValue = useMemo<McpContextValue>(() => {
    return {
      registerTool: (name, tool) => {
        client.registerTool(name, tool);
      },
      removeState: (key) => {
        client.removeState(key);
      },
      setState: (key, value) => {
        client.setState(key, value);
      },
      unregisterTool: (name) => {
        client.unregisterTool(name);
      },
    };
  }, [client]);

  return createElement(
    McpContext.Provider,
    { value: contextValue },
    // eslint-disable-next-line react-hooks/refs
    createElement(getView(), { collapsable: false, ref: rootRef, style: { flex: 1 } }, children)
  );
};
