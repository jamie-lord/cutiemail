/**
 * Neutralise terminal control characters before printing attacker-controlled bytes to the
 * operator's terminal. Remote-derived
 * strings — a dead-lettered message's bytes, a remote MX's error/greeting text, a spoofable
 * DNS/DMARC record — can carry ANSI/OSC escape sequences: OSC 52 to hijack the clipboard, CSI
 * to erase/forge output (e.g. paint a fake "ok" verdict). Strip C0 controls (keeping tab/CR/LF
 * for readability), DEL, and the C1 range (0x80–0x9f, which some terminals treat as 8-bit escape
 * introducers). ESC (0x1b) is in the stripped range, so no escape sequence can be introduced.
 * A lone CR (0x0d not part of a CRLF) returns the cursor to column 0 and lets attacker text
 * overwrite the visible line (display forgery) — neutralise it too.
 */
const TERMINAL_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export const sanitizeForTerminal = (s: string): string => s.replace(/\r(?!\n)/g, '.').replace(TERMINAL_CONTROLS, '.');

/**
 * Single-line variant: additionally collapse CR/LF/TAB to a space. The multi-line
 * sanitizeForTerminal keeps \n and \t (queue-cli dumps whole headers), but a caller that emits
 * exactly ONE line per record (doctor's reportChecks) must neutralise an embedded newline too —
 * a remote \n in a one-line detail would otherwise inject an extra terminal line byte-identical
 * to a genuine "ok" verdict, forging a healthy result.
 */
export const sanitizeForTerminalLine = (s: string): string => sanitizeForTerminal(s).replace(/[\t\n\r]+/g, ' ');
