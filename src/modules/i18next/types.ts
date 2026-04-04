export interface I18nLike {
  changeLanguage: (lng: string) => Promise<unknown>;
  getResource: (lng: string, ns: string) => Record<string, unknown> | undefined;
  language: string;
  languages: readonly string[];
  options: {
    defaultNS?: string | string[];
    ns?: string | string[];
  };
  t: (key: string, options?: Record<string, unknown>) => string;
}
