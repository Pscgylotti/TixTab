/** Literal RGBA tuples at each pixel; no tolerance, interpolation or channel mixing. */
export function novelRgba(candidate, references) {
  if (
    !references.length ||
    candidate.length % 4 ||
    references.some((r) => r.length !== candidate.length)
  )
    throw new RangeError('Matching RGBA buffers and references required');
  let novel = 0,
    variable = 0;
  const examples = [];
  for (let p = 0; p < candidate.length; p += 4) {
    let found = false,
      differs = false;
    const first = references[0];
    for (const r of references) {
      if (
        r[p] === candidate[p] &&
        r[p + 1] === candidate[p + 1] &&
        r[p + 2] === candidate[p + 2] &&
        r[p + 3] === candidate[p + 3]
      )
        found = true;
      if (
        r[p] !== first[p] ||
        r[p + 1] !== first[p + 1] ||
        r[p + 2] !== first[p + 2] ||
        r[p + 3] !== first[p + 3]
      )
        differs = true;
    }
    if (differs) variable++;
    if (!found) {
      novel++;
      if (examples.length < 12)
        examples.push({
          pixel: p / 4,
          rgba: Array.from(candidate.slice(p, p + 4)),
          observed: references.map((r) => Array.from(r.slice(p, p + 4))),
        });
    }
  }
  return { novelPixels: novel, variableReferencePixels: variable, examples };
}
