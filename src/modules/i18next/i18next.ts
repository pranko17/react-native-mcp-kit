import { type McpModule } from '@/client/models/types';

import { type I18nLike } from './types';

const flattenKeys = (obj: Record<string, unknown>, prefix = ''): string[] => {
  const keys: string[] = [];
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
};

export const i18nextModule = (i18n: I18nLike): McpModule => {
  const getNamespaces = (): string[] => {
    const ns = i18n.options.ns ?? i18n.options.defaultNS;
    if (!ns || ns === false) return ['translation'];
    if (Array.isArray(ns)) return ns as string[];
    return [ns as string];
  };

  return {
    description: `i18next translation inspection + runtime control.

Works against an injected i18next instance. \`language\` and \`namespace\`
default to the current language / first-registered namespace respectively.
Interpolation options are passed as a JSON string to keep the schema
flat.`,
    name: 'i18n',
    tools: {
      change_language: {
        description: 'Switch the active language.',
        handler: async (args) => {
          await i18n.changeLanguage(args.language as string);
          return { language: i18n.language, success: true };
        },
        inputSchema: {
          language: {
            description: 'Language code.',
            examples: ['en', 'de', 'fr'],
            minLength: 1,
            type: 'string',
          },
        },
      },
      get_info: {
        description: 'Current language + available languages + registered namespaces.',
        handler: () => {
          return {
            currentLanguage: i18n.language,
            languages: [...i18n.languages],
            namespaces: getNamespaces(),
          };
        },
      },
      get_keys: {
        description: 'All translation keys for a language + namespace.',
        handler: (args) => {
          const lng = (args.language as string) || i18n.language;
          const ns = (args.namespace as string) || getNamespaces()[0] || 'translation';
          const resource = i18n.getResource(lng, ns);
          if (!resource) return { error: `No resource for ${lng}/${ns}` };
          return { keys: flattenKeys(resource), language: lng, namespace: ns };
        },
        inputSchema: {
          language: {
            description: 'Language code. Defaults to the current language.',
            type: 'string',
          },
          namespace: {
            description: 'Namespace. Defaults to the first registered namespace.',
            type: 'string',
          },
        },
      },
      get_resource: {
        description: 'Full translation resource object for a language + namespace.',
        handler: (args) => {
          const lng = (args.language as string) || i18n.language;
          const ns = (args.namespace as string) || getNamespaces()[0] || 'translation';
          const resource = i18n.getResource(lng, ns);
          if (!resource) return { error: `No resource for ${lng}/${ns}` };
          return { language: lng, namespace: ns, resource };
        },
        inputSchema: {
          language: {
            description: 'Language code. Defaults to the current language.',
            type: 'string',
          },
          namespace: {
            description: 'Namespace. Defaults to the first registered namespace.',
            type: 'string',
          },
        },
      },
      search: {
        description: 'Substring search across keys and values in every namespace.',
        handler: (args) => {
          const query = (args.query as string).toLowerCase();
          const lng = (args.language as string) || i18n.language;
          const results: Array<{ key: string; namespace: string; value: string }> = [];

          for (const ns of getNamespaces()) {
            const resource = i18n.getResource(lng, ns);
            if (!resource) continue;
            const keys = flattenKeys(resource);
            for (const key of keys) {
              const value = i18n.t(`${ns}:${key}`);
              if (key.toLowerCase().includes(query) || value.toLowerCase().includes(query)) {
                results.push({ key, namespace: ns, value });
              }
            }
          }
          return results;
        },
        inputSchema: {
          language: {
            description: 'Language code. Defaults to the current language.',
            type: 'string',
          },
          query: {
            description: 'Substring to match against keys and values.',
            minLength: 1,
            type: 'string',
          },
        },
      },
      translate: {
        description: 'Translate a key, with optional interpolation.',
        handler: (args) => {
          const key = args.key as string;
          let options: Record<string, unknown> | undefined;
          if (args.options) {
            try {
              options = JSON.parse(args.options as string) as Record<string, unknown>;
            } catch {
              return { error: 'Invalid JSON in options' };
            }
          }
          return { key, value: i18n.t(key, options) };
        },
        inputSchema: {
          key: {
            description: 'Translation key.',
            examples: ['auth:login.title', 'common:ok'],
            minLength: 1,
            type: 'string',
          },
          options: {
            description: 'Interpolation options (JSON string).',
            examples: ['{"name":"John"}'],
            type: 'string',
          },
        },
      },
    },
  };
};
