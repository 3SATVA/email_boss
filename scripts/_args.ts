/** Tiny argv parser: --key value, --flag, repeated --tag a --tag b. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split("=", 2);
    const v = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
    (out[k] ??= []).push(v);
  }
  return {
    get: (k: string) => out[k]?.[out[k].length - 1],
    all: (k: string) => out[k] ?? [],
    has: (k: string) => k in out,
    positional,
  };
}
