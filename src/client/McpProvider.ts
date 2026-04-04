import { createElement, useEffect, useMemo, useRef } from 'react';

import type { ToolRequest } from '../shared/protocol';
import { McpContext } from './McpContext';
import { McpConnection } from './connection';
import { ModuleRunner } from './module-runner';
import type { McpContextValue, McpProviderProps, ToolHandler } from './types';

const DEFAULT_PORT = 8347;

export const McpProvider = ({ children, modules = [], port = DEFAULT_PORT }: McpProviderProps) => {
  const connectionRef = useRef<McpConnection | null>(null);
  const runnerRef = useRef<ModuleRunner>(new ModuleRunner());

  useEffect(() => {
    const runner = runnerRef.current;
    runner.registerModules(modules);

    const connection = new McpConnection(port);
    connectionRef.current = connection;

    connection.onOpen(() => {
      connection.send({
        modules: runner.getModuleDescriptors(),
        type: 'registration',
      });
    });

    connection.onMessage((message: ToolRequest) => {
      if (message.type === 'tool_request') {
        runner
          .handleRequest(message)
          .then((result) => {
            connection.send({
              id: message.id,
              result,
              type: 'tool_response',
            });
          })
          .catch((error: Error) => {
            connection.send({
              error: error.message,
              id: message.id,
              type: 'tool_response',
            });
          });
      }
    });

    connection.connect();

    return () => {
      connection.dispose();
      connectionRef.current = null;
    };
    // modules are provided once at mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  const contextValue = useMemo<McpContextValue>(() => {
    return {
      registerTool: (name: string, tool: ToolHandler) => {
        runnerRef.current.registerDynamicTool(name, tool);
        connectionRef.current?.send({
          module: '_dynamic',
          tool: {
            description: tool.description,
            inputSchema: tool.inputSchema,
            name,
          },
          type: 'tool_register',
        });
      },
      removeState: (key: string) => {
        connectionRef.current?.send({
          key,
          type: 'state_remove',
        });
      },
      setState: (key: string, value: unknown) => {
        connectionRef.current?.send({
          key,
          type: 'state_update',
          value,
        });
      },
      unregisterTool: (name: string) => {
        runnerRef.current.unregisterDynamicTool(name);
        connectionRef.current?.send({
          module: '_dynamic',
          toolName: name,
          type: 'tool_unregister',
        });
      },
    };
  }, []);

  return createElement(McpContext.Provider, { value: contextValue }, children);
};
