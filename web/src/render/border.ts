/** The outline of the land a village holds: the edge of the union of discs [x, y, r] (the hall's circle and a patch round every building). No drawing code in here. */
export function territoryOutline(discs: ArrayLike<number>, step = 2.4): number[] {
  const n = Math.floor(discs.length / 3), segs: number[] = [];
  const covered = (i: number, x: number, z: number) => {
    for (let j = 0; j < n; j++) { if (j === i) continue; const dx = x - discs[j * 3], dz = z - discs[j * 3 + 1], r = discs[j * 3 + 2]; if (Math.abs(dx) < r && Math.abs(dz) < r && dx * dx + dz * dz < r * r - 0.01) return true; }
    return false;
  };
  for (let i = 0; i < n; i++) {
    const cx = discs[i * 3], cz = discs[i * 3 + 1], r = discs[i * 3 + 2], m = Math.max(16, Math.ceil((Math.PI * 2 * r) / step));
    let prev: [number, number] | null = null, first: [number, number] | null = null, prevKept = false, firstKept = false;
    for (let k = 0; k <= m; k++) {
      const a = (k / m) * Math.PI * 2, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, kept: boolean = k === m ? firstKept : !covered(i, x, z);
      if (k === 0) { first = [x, z]; firstKept = kept; }
      if (prev && prevKept && kept) segs.push(prev[0], prev[1], k === m && first ? first[0] : x, k === m && first ? first[1] : z);
      prev = [x, z]; prevKept = kept;
    }
  }
  return segs;
}
