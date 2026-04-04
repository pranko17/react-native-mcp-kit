// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface I18nLike {
  changeLanguage: (lng: string) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getResource: (...args: any[]) => any;
  language: string;
  languages: readonly string[];
  options: {
    defaultNS?: unknown;
    ns?: unknown;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (...args: any[]) => string;
}
