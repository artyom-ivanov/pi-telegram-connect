import { resolve, sep, basename } from "node:path";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

const FORBIDDEN_NAME = /^[.]+$/;

/**
 * Sanitize a Telegram-supplied filename.
 * - basename to defeat traversal
 * - strip to [A-Za-z0-9._-]
 * - cap at 80 chars
 * - reject empty / dotfiles → fallback
 */
export function sanitizeFilename(input: string | undefined | null, fallback: string): string {
  if (!input) return fallback;
  const base = basename(String(input));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  if (!cleaned || FORBIDDEN_NAME.test(cleaned)) return fallback;
  return cleaned;
}

/**
 * Assert that `child` resolves to a path inside `root`.
 */
export async function assertInsideRoot(
  child: string,
  root: string,
  followSymlinks: boolean,
): Promise<string> {
  const rootAbs = resolve(expandHome(root));
  let childAbs = resolve(expandHome(child));
  if (followSymlinks) {
    try {
      childAbs = await realpath(childAbs);
    } catch {
      // file may not exist yet
    }
  }
  const rootWithSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (childAbs !== rootAbs && !childAbs.startsWith(rootWithSep)) {
    throw new Error(`path_outside_sandbox: ${childAbs} not under ${rootAbs}`);
  }
  return childAbs;
}
