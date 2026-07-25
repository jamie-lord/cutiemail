/**
 * "Is this module the program, or is it being imported?"
 *
 * Every entry point in this tree asks that question, and the obvious ways to ask it are all wrong
 * in the same way: `import.meta.url` has symlinks RESOLVED, while `process.argv[1]` is the path as
 * the caller typed it. Compare them directly and any invocation through a symlink answers "I am
 * being imported" — so the module loads, runs nothing, and the process exits 0 in a few hundred
 * milliseconds with no output at all.
 *
 * That is not a hypothetical. ADR 0025's version store exists to make a cutover a symlink rename:
 * the code lives at `versions/<commit>` and `current` points at whichever one runs, so the service
 * unit necessarily says `ExecStart=/opt/mailserver/current/src/main.ts`. Every deployment laid out
 * the way this project's own deploy script lays it out therefore started the daemon, resolved
 * `current` to a real path that did not match argv[1], and quietly did nothing. systemd reports
 * that as `Deactivated successfully` — a dead server behind a success message.
 *
 * Resolving BOTH sides is the fix, and it also disposes of a second, quieter bug: building a URL
 * with `file://${process.argv[1]}` does no percent-encoding, so a path containing a space or a `#`
 * never matched either. Comparing real filesystem paths avoids the URL round trip entirely.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when `moduleUrl` names the file the process was started with.
 *
 * Pass `import.meta.url` and `process.argv[1]`. Both are resolved through the filesystem before
 * comparison, so a symlinked install directory, a bind mount, or macOS's `/tmp` → `/private/tmp`
 * all answer correctly.
 *
 * A path that cannot be resolved — argv[1] absent (the REPL, `node -e`), or a file deleted between
 * spawn and this call — answers `false`. That is the safe direction: a module that wrongly thinks
 * it is being imported does nothing, while one that wrongly thinks it is the program starts a mail
 * server inside whatever imported it.
 */
export function invokedDirectly(moduleUrl: string, entryPath: string | undefined): boolean {
  if (entryPath === undefined || entryPath === '') return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath);
  } catch {
    return false;
  }
}
