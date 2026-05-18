// React internal fiber tag values. We poke them via `fiber.tag === HOST_COMPONENT`
// etc. rather than importing from `react-reconciler` because the package isn't
// part of RN's runtime export surface, and the constants are stable across the
// supported React 18 / 19 line.

export const HOST_COMPONENT = 5;
export const HOST_TEXT = 6;
export const FUNCTION_COMPONENT = 0;
export const CLASS_COMPONENT = 1;
export const FORWARD_REF = 11;
export const MEMO = 14;
export const SIMPLE_MEMO = 15;
