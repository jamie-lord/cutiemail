/**
 * Neutralise terminal control characters before printing attacker-controlled bytes to the
 * operator's terminal (audit run-1 finding 5; extended to `doctor` in run-6). Remote-derived
 * strings — a dead-lettered message's bytes, a remote MX's error/greeting text, a spoofable
 * DNS/DMARC record — can carry ANSI/OSC escape sequences: OSC 52 to hijack the clipboard, CSI
 * to erase/forge output (e.g. paint a fake "ok" verdict). Strip C0 controls (keeping tab/CR/LF
 * for readability), DEL, and the C1 range (0x80–0x9f, which some terminals treat as 8-bit escape
 * introducers). ESC (0x1b) is in the stripped range, so no escape sequence can be introduced.
 * A lone CR (0x0d not part of a CRLF) returns the cursor to column 0 and lets attacker text
 * overwrite the visible line (display forgery) — neutralise it too (audit run-2 finding 5).
 */
const TERMINAL_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export const sanitizeForTerminal = (s: string): string => s.replace(/\r(?!\n)/g, '.').replace(TERMINAL_CONTROLS, '.');
