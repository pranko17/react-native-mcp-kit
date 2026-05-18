import { parseNamePattern } from './patterns';
import { type HooksOptions, type HooksRawOptions } from './types';

/**
 * Normalise a raw `select.hooks` object into the strict `HooksOptions`
 * shape the extractor walks against. Splits ambiguous fields (`depth` →
 * `valueDepth`, etc.) and compiles name-pattern strings via
 * `parseNamePattern`. Used by `parseProjection`.
 */
export const buildHooksOptions = (raw: HooksRawOptions | undefined): HooksOptions => {
  return {
    expansionDepth:
      typeof raw?.expansionDepth === 'number' && raw.expansionDepth >= 0
        ? Math.floor(raw.expansionDepth)
        : Infinity,
    format: raw?.format === 'tree' ? 'tree' : 'flat',
    kindsSet: Array.isArray(raw?.kinds) ? new Set(raw.kinds) : null,
    mcpIdMatchers: Array.isArray(raw?.mcpIds) ? raw.mcpIds.map(parseNamePattern) : null,
    nameMatchers: Array.isArray(raw?.names) ? raw.names.map(parseNamePattern) : null,
    valueDepth: typeof raw?.depth === 'number' && raw.depth >= 0 ? raw.depth : undefined,
    valueMaxBytes:
      typeof raw?.maxBytes === 'number' && raw.maxBytes >= 0 ? raw.maxBytes : undefined,
    valuePath: typeof raw?.path === 'string' ? raw.path : undefined,
    withValues: raw?.withValues === true,
  };
};
