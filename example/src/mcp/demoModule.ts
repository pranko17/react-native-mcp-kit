import { type McpModule } from 'react-native-mcp-kit';

// A fully custom module passed through `<McpProvider modules={[demoModule()]} />`.
// Demonstrates the third registration path (the other two — provider props and
// useMcpModule/useMcpTool — are shown elsewhere in the app).
//
// Agents see it in `list_tools` as `demo` and call e.g. `call("demo__echo")`.
export const demoModule = (): McpModule => ({
  name: 'demo',
  description:
    'Custom app-defined module (registered via the McpProvider `modules` prop). ' +
    'Static helpers an agent can call to orient itself in this demo app.',
  tools: {
    app_info: {
      description: 'Static metadata about this demo app and which screen exercises which module.',
      handler: async () => ({
        name: 'McpKitExample',
        purpose: 'Showcase every react-native-mcp-kit capability in one running RN app.',
        screens: {
          Home: ['fiber_tree', 'navigation', 'dynamic session tools'],
          Shop: ['query', 'network', 'fiber_tree (ProductCard list)'],
          Cart: ['redux (cart slice)'],
          Tools: ['alert', 'console', 'errors', 'log_box', 'network', 'feature_flags'],
          Settings: ['i18n', 'redux (counter/settings)', 'storage', 'device', 'session'],
        },
      }),
    },
    echo: {
      description: 'Echo back the provided message — handy for a connectivity smoke test.',
      inputSchema: { message: { type: 'string' } },
      handler: async (args) => ({ echoed: args.message ?? null }),
    },
    sum: {
      description: 'Add two numbers and return the result.',
      inputSchema: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      handler: async (args) => ({ result: Number(args.a ?? 0) + Number(args.b ?? 0) }),
    },
  },
});
