// Lanes for the commit graph in the Git tab. Pure, so tests can check it.
import type { GitCommit } from '../../../src/server/api-types.js';

export interface Row {
  commit: GitCommit;
  col: number;
  /** Lines from the top edge (lane x) to the bottom edge (lane x), and from the dot to the bottom (parents). */
  through: [number, number][];
  into: number[];
  out: number[];
  lanes: number;
}

/** Lanes for a list of commits, newest first: each open lane waits for one commit. */
export function layoutGraph(commits: GitCommit[]): Row[] {
  let lanes: (string | null)[] = [];
  const rows: Row[] = [];
  for (const c of commits) {
    let col = lanes.indexOf(c.sha);
    if (col < 0) {
      col = lanes.indexOf(null);
      if (col < 0) col = lanes.push(null) - 1;
    }
    const before = lanes;
    const after = [...lanes];
    // Every lane waiting for this commit ends here.
    const into = before.flatMap((h, i) => (h === c.sha ? [i] : []));
    for (const i of into) after[i] = null;
    const [first, ...others] = c.parents;
    // A parent another lane already waits for joins that lane.
    after[col] = first && !after.includes(first) ? first : null;
    for (const p of others) {
      if (!after.includes(p)) {
        const free = after.indexOf(null);
        if (free >= 0) after[free] = p;
        else after.push(p);
      }
    }
    const through: [number, number][] = before.flatMap((h, i) => (h && h !== c.sha ? [[i, after.indexOf(h)] as [number, number]] : []));
    const out = c.parents.map((p) => after.indexOf(p)).filter((i) => i >= 0);
    while (after.length && after.at(-1) === null) after.pop();
    lanes = after;
    rows.push({ commit: c, col, through, into, out, lanes: Math.max(before.length, after.length, col + 1) });
  }
  return rows;
}
