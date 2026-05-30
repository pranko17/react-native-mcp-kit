/**
 * Jest mock for `react-native-mcp-kit`.
 *
 * Point a consumer's jest config at it so unit tests never load the real
 * client (which opens a WebSocket and lazy-requires react-native):
 *
 *   // jest config
 *   moduleNameMapper: { '^react-native-mcp-kit$': 'react-native-mcp-kit/jest' }
 *
 * Everything is a no-op. A value comes back only where a caller needs one:
 * the provider renders its children, factories return a valid empty module,
 * and `registerModule`/`registerModules` return a disposer. There is no
 * `react` / `react-native` runtime import — types are pulled from the real
 * API (erased at runtime), so the mock stays in full type-compliance without
 * dragging peer deps into the jest resolver (the very thing it sidesteps).
 */

// `typeof import()` references the real public API's types without importing it
// at runtime (the whole point of the mock — no real client, no peer-dep resolve).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type Api = typeof import('@/index');
type AnyModule = ReturnType<Api['alertModule']>;

const noop = (): void => {
  return undefined;
};

const emptyModule = (name: string): AnyModule => {
  return { name, tools: {} };
};

// React entry points — the provider just renders children (no react import).
export const McpProvider = ((props: { children?: unknown }) => {
  return props.children;
}) as unknown as Api['McpProvider'];

export const McpContext = {
  Consumer: () => {
    return null;
  },
  Provider: (props: { children?: unknown }) => {
    return props.children;
  },
} as unknown as Api['McpContext'];

export const useMcpModule: Api['useMcpModule'] = noop;
export const useMcpTool: Api['useMcpTool'] = noop;

// McpClient — static + instance no-ops; registerModule(s) hand back a disposer.
class McpClientMock {
  static getInstance(): McpClientMock {
    return new McpClientMock();
  }

  static initialize(): McpClientMock {
    return new McpClientMock();
  }

  dispose(): void {
    return undefined;
  }

  enableDebug(): void {
    return undefined;
  }

  registerModule(): () => void {
    return noop;
  }

  registerModules(): () => void {
    return noop;
  }

  registerTool(): void {
    return undefined;
  }

  unregisterModule(): void {
    return undefined;
  }

  unregisterModules(): void {
    return undefined;
  }

  unregisterTool(): void {
    return undefined;
  }
}

export const McpClient = McpClientMock as unknown as Api['McpClient'];

// Module factories — each returns a valid empty module under its registered name.
export const alertModule: Api['alertModule'] = () => {
  return emptyModule('alert');
};
export const consoleModule: Api['consoleModule'] = () => {
  return emptyModule('console');
};
export const deviceModule: Api['deviceModule'] = () => {
  return emptyModule('device');
};
export const errorsModule: Api['errorsModule'] = () => {
  return emptyModule('errors');
};
export const fiberTreeModule: Api['fiberTreeModule'] = () => {
  return emptyModule('fiber_tree');
};
export const i18nextModule: Api['i18nextModule'] = () => {
  return emptyModule('i18n');
};
export const logBoxModule: Api['logBoxModule'] = () => {
  return emptyModule('log_box');
};
export const navigationModule: Api['navigationModule'] = () => {
  return emptyModule('navigation');
};
export const networkModule: Api['networkModule'] = () => {
  return emptyModule('network');
};
export const reactQueryModule: Api['reactQueryModule'] = () => {
  return emptyModule('query');
};
export const reduxModule: Api['reduxModule'] = () => {
  return emptyModule('redux');
};
export const storageModule: Api['storageModule'] = () => {
  return emptyModule('storage');
};

// Types — erased at runtime; keep consumers' type-only imports resolving.
export {
  type ClientMessage,
  type McpContextValue,
  type McpModule,
  type McpProviderProps,
  type ModuleDescriptor,
  type ModuleToolDescriptor,
  type RegistrationMessage,
  type ServerMessage,
  type ToolHandler,
  type ToolRegisterMessage,
  type ToolRequest,
  type ToolResponse,
  type ToolUnregisterMessage,
} from '@/index';
