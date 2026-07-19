import { describe, expect, it } from 'vitest';

import { type McpModule } from '@/client/models/types';
import { i18nextModule, type I18nLike } from '@/modules/i18next';

type Resources = Record<string, Record<string, Record<string, unknown>>>;

const resources: Resources = {
  de: {
    auth: { login: { title: 'Anmelden' } },
    common: { farewell: 'Tschüss', greeting: 'Hallo {{name}}' },
  },
  en: {
    auth: { login: { button: 'Sign in', title: 'Login' } },
    common: { farewell: 'Bye', greeting: 'Hello {{name}}' },
  },
};

interface FakeI18n {
  changeLanguageCalls: string[];
  i18n: I18nLike;
}

const makeFakeI18n = (options: I18nLike['options'] = { ns: ['common', 'auth'] }): FakeI18n => {
  const changeLanguageCalls: string[] = [];
  const lookup = (lng: string, ns: string, keyPath: string): unknown => {
    let node: unknown = resources[lng]?.[ns];
    for (const part of keyPath.split('.')) {
      if (!node || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  };
  const i18n: I18nLike = {
    changeLanguage: async (lng) => {
      changeLanguageCalls.push(lng);
      i18n.language = lng;
    },
    getResource: (lng: string, ns: string) => {
      return resources[lng]?.[ns];
    },
    language: 'en',
    languages: ['en', 'de'],
    options,
    t: (...args: unknown[]) => {
      const rawKey = args[0] as string;
      const opts = args[1] as Record<string, unknown> | undefined;
      const colon = rawKey.indexOf(':');
      const ns = colon === -1 ? 'common' : rawKey.slice(0, colon);
      const keyPath = colon === -1 ? rawKey : rawKey.slice(colon + 1);
      const value = lookup(i18n.language, ns, keyPath);
      if (typeof value !== 'string') return rawKey;
      return value.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
        return opts && name in opts ? String(opts[name]) : match;
      });
    },
  };
  return { changeLanguageCalls, i18n };
};

const call = (mod: McpModule, tool: string, args: Record<string, unknown> = {}): unknown => {
  return mod.tools[tool]!.handler(args);
};

describe('i18nextModule translate', () => {
  it('translates a key without options', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'translate', { key: 'common:farewell' })).toEqual({
      key: 'common:farewell',
      value: 'Bye',
    });
  });

  it('applies interpolation options passed as a JSON string', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'translate', { key: 'common:greeting', options: '{"name":"John"}' })).toEqual({
      key: 'common:greeting',
      value: 'Hello John',
    });
  });

  it('returns an error for malformed options JSON', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'translate', { key: 'common:greeting', options: '{bad' })).toEqual({
      error: 'Invalid JSON in options',
    });
  });

  it('falls back to the key itself for a missing translation', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'translate', { key: 'common:nope' })).toEqual({
      key: 'common:nope',
      value: 'common:nope',
    });
  });
});

describe('i18nextModule change_language', () => {
  it('switches the active language and records the call', async () => {
    const { changeLanguageCalls, i18n } = makeFakeI18n();
    const mod = i18nextModule(i18n);
    expect(await call(mod, 'change_language', { language: 'de' })).toEqual({
      language: 'de',
      success: true,
    });
    expect(changeLanguageCalls).toEqual(['de']);
    expect(call(mod, 'translate', { key: 'common:farewell' })).toEqual({
      key: 'common:farewell',
      value: 'Tschüss',
    });
  });
});

describe('i18nextModule get_info', () => {
  it('reports current language, available languages and namespaces', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'get_info')).toEqual({
      currentLanguage: 'en',
      languages: ['en', 'de'],
      namespaces: ['common', 'auth'],
    });
  });

  it.each<[string, I18nLike['options'], string[]]>([
    ['no ns config', {}, ['translation']],
    ['ns explicitly false', { ns: false }, ['translation']],
    ['a string ns', { ns: 'single' }, ['single']],
    ['a defaultNS fallback', { defaultNS: 'main' }, ['main']],
  ])('derives namespaces from %s', (_label, options, expected) => {
    const mod = i18nextModule(makeFakeI18n(options).i18n);
    expect(call(mod, 'get_info')).toMatchObject({ namespaces: expected });
  });
});

describe('i18nextModule get_keys', () => {
  it('defaults to the current language and first namespace', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'get_keys')).toEqual({
      keys: ['farewell', 'greeting'],
      language: 'en',
      namespace: 'common',
    });
  });

  it('flattens nested keys with dot notation', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'get_keys', { namespace: 'auth' })).toEqual({
      keys: ['login.button', 'login.title'],
      language: 'en',
      namespace: 'auth',
    });
  });

  it('honours explicit language and namespace', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'get_keys', { language: 'de', namespace: 'auth' })).toEqual({
      keys: ['login.title'],
      language: 'de',
      namespace: 'auth',
    });
  });

  it('returns an error when the resource is missing', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'get_keys', { language: 'fr' })).toEqual({
      error: 'No resource for fr/common',
    });
  });
});

describe('i18nextModule get_resource', () => {
  it('returns the raw resource object with resolved defaults', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'get_resource')).toEqual({
      language: 'en',
      namespace: 'common',
      resource: { farewell: 'Bye', greeting: 'Hello {{name}}' },
    });
  });

  it('returns an error for an unknown namespace', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'get_resource', { namespace: 'ghost' })).toEqual({
      error: 'No resource for en/ghost',
    });
  });
});

describe('i18nextModule search', () => {
  it('matches keys by substring across every namespace', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'search', { query: 'login' })).toEqual([
      { key: 'login.button', namespace: 'auth', value: 'Sign in' },
      { key: 'login.title', namespace: 'auth', value: 'Login' },
    ]);
  });

  it('matches translated values case-insensitively', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'search', { query: 'HELLO' })).toEqual([
      { key: 'greeting', namespace: 'common', value: 'Hello {{name}}' },
    ]);
  });

  it('collects keys from the requested language', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'search', { language: 'de', query: 'button' })).toEqual([]);
    expect(call(mod, 'search', { query: 'button' })).toEqual([
      { key: 'login.button', namespace: 'auth', value: 'Sign in' },
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    const mod = i18nextModule(makeFakeI18n().i18n);
    expect(call(mod, 'search', { query: 'zzz-not-there' })).toEqual([]);
  });
});
