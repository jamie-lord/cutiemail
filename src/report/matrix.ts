/**
 * The per-server conformance matrix: requirement × server, four-state.
 *
 * The output a human actually reads to answer "how does Postfix 3.8 do against
 * RFC 5321, and where does it differ from Exim, Stalwart, Mox?". It is built from
 * dated, versioned runs — never hand-maintained — because the single worst flaw
 * in the most comparable prior artefact (Dovecot's published imaptest compliancy
 * table) is that the tool stayed current while the results silently rotted to ~14
 * years stale, and it still ships with an "out-of-date" banner.
 *
 * So staleness is structural here: every run carries the server version and the
 * run timestamp, both are rendered on every view, and there is no code path that
 * produces a matrix without them. A reader can always see how old a result is
 * and against which version.
 */

import type { Result, Outcome } from '../conformance/outcome.ts';

export interface RunMetadata {
  readonly serverName: string;
  /** Verbatim version string. Absent is allowed but rendered as "UNKNOWN". */
  readonly serverVersion: string | undefined;
  /** ISO 8601. Passed in — the workflow env forbids Date.now(), and a run's time
   *  is a property of the run, not of rendering. */
  readonly runAt: string;
  readonly suiteCommit: string | undefined;
}

export interface ServerRun {
  readonly meta: RunMetadata;
  readonly results: readonly Result[];
}

export interface MatrixCell {
  readonly outcome: Outcome;
  readonly testId: string;
}

export interface MatrixRow {
  readonly requirementId: string;
  readonly level: Result['level'];
  /** serverName -> cell. Absent server means the requirement was not run there. */
  readonly cells: ReadonlyMap<string, MatrixCell>;
  /** True when servers disagree — the most interesting rows for a suite author. */
  readonly divergent: boolean;
}

export interface Matrix {
  readonly servers: readonly RunMetadata[];
  readonly rows: readonly MatrixRow[];
  /** Rows where at least two servers produced different outcomes. */
  readonly divergences: readonly MatrixRow[];
  readonly perServerSummary: ReadonlyMap<string, Readonly<Record<Outcome, number>>>;
}

function summarise(results: readonly Result[]): Record<Outcome, number> {
  const s: Record<Outcome, number> = {
    conformant: 0,
    'non-conformant': 0,
    'permitted-latitude': 0,
    inconclusive: 0,
  };
  for (const r of results) s[r.outcome]++;
  return s;
}

/**
 * Two outcomes "disagree" for divergence purposes only when the disagreement is
 * substantive. inconclusive-vs-anything is NOT a divergence — it usually means
 * one run lacked a fixture the other had, which is a property of the runs, not
 * the servers. Folding it in would drown the real divergences in noise.
 */
function substantiveDisagreement(outcomes: readonly Outcome[]): boolean {
  const meaningful = outcomes.filter((o) => o !== 'inconclusive');
  return new Set(meaningful).size > 1;
}

export function buildMatrix(runs: readonly ServerRun[]): Matrix {
  const servers = runs.map((r) => r.meta);
  const reqIds = new Set<string>();
  for (const run of runs) for (const r of run.results) reqIds.add(r.requirementId);

  const rows: MatrixRow[] = [];
  for (const requirementId of [...reqIds].sort()) {
    const cells = new Map<string, MatrixCell>();
    let level: Result['level'] = 'MUST';
    for (const run of runs) {
      const result = run.results.find((r) => r.requirementId === requirementId);
      if (result !== undefined) {
        cells.set(run.meta.serverName, { outcome: result.outcome, testId: result.testId });
        level = result.level;
      }
    }
    const divergent = substantiveDisagreement([...cells.values()].map((c) => c.outcome));
    rows.push({ requirementId, level, cells, divergent });
  }

  const perServerSummary = new Map<string, Record<Outcome, number>>();
  for (const run of runs) perServerSummary.set(run.meta.serverName, summarise(run.results));

  return {
    servers,
    rows,
    divergences: rows.filter((r) => r.divergent),
    perServerSummary,
  };
}

const GLYPH: Record<Outcome, string> = {
  conformant: 'OK ',
  'non-conformant': 'X  ',
  'permitted-latitude': '~  ',
  inconclusive: '?  ',
};

export function renderMatrix(matrix: Matrix): string {
  const lines: string[] = ['RFC 5321 CONFORMANCE MATRIX', '='.repeat(70), ''];

  // Provenance first, and unmissable — this is the anti-staleness contract.
  lines.push('Servers under test:');
  for (const s of matrix.servers) {
    lines.push(
      `  ${s.serverName}  version=${s.serverVersion ?? 'UNKNOWN'}  ` +
        `run=${s.runAt}  suite=${s.suiteCommit ?? 'UNKNOWN'}`,
    );
  }
  lines.push('');
  lines.push('Legend: OK conformant | X non-conformant | ~ permitted-latitude | ? inconclusive');
  lines.push('');

  lines.push('Per-server summary:');
  for (const [name, s] of matrix.perServerSummary) {
    lines.push(
      `  ${name}: ${s.conformant} OK, ${s['non-conformant']} X, ` +
        `${s['permitted-latitude']} ~, ${s.inconclusive} ?`,
    );
  }
  lines.push('');

  // Divergences are the payoff: where implementations actually disagree.
  if (matrix.divergences.length > 0) {
    lines.push(`DIVERGENCES (${matrix.divergences.length}) — where servers disagree:`);
    for (const row of matrix.divergences) {
      const cells = matrix.servers
        .map((s) => `${s.serverName}=${GLYPH[row.cells.get(s.serverName)?.outcome ?? 'inconclusive'].trim()}`)
        .join('  ');
      lines.push(`  ${row.requirementId} (${row.level}): ${cells}`);
    }
    lines.push('');
  } else {
    lines.push('No substantive divergences among the servers run.', '');
  }

  return lines.join('\n');
}
