// Class names of a screen's stylesheet: `s.card` -> "co-card". Plain global CSS with a
// per-screen prefix (the project's CSS loader does not keep CSS-module scoping).
export const classes = (prefix: string): Record<string, string> => new Proxy({}, { get: (_, k) => `${prefix}-${String(k)}` });
