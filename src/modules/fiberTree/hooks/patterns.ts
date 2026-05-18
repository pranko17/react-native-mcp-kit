// Parse a name pattern: `/regex/flags` → RegExp matcher; anything else →
// exact-string matcher. Same convention as log_box__ignore.
export const parseNamePattern = (raw: string): ((n: string) => boolean) => {
  const m = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (m && m[1] !== undefined) {
    try {
      const rx = new RegExp(m[1], m[2] ?? '');
      return (n) => {
        return rx.test(n);
      };
    } catch {
      return (n) => {
        return n === raw;
      };
    }
  }
  return (n) => {
    return n === raw;
  };
};
