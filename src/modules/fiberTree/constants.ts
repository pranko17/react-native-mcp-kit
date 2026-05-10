/**
 * Numeric limits / defaults shared across the fiberTree module. Kept in
 * one file so the tunables are easy to spot and adjust without trawling
 * through handler logic.
 */

// `query` response size knobs.
export const QUERY_LIMIT_DEFAULT = 50;
export const QUERY_LIMIT_MAX = 500;

// `query.waitFor` polling knobs.
export const WAIT_TIMEOUT_DEFAULT = 10_000;
export const WAIT_TIMEOUT_MAX = 60_000;
export const WAIT_INTERVAL_DEFAULT = 300;
export const WAIT_INTERVAL_MIN = 100;

// Default depth for fiberTree handlers passing through the shared
// projection. The typical response shape has 3 nesting layers before the
// heavy values start (response → matches array → match object → match
// fields → props content). depth=4 shows all match-level fields with
// heavy nested values (props.style etc.) already collapsed into markers
// — a useful balance of visibility vs lean.
export const FIBER_DEFAULT_DEPTH = 4;
