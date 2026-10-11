import type { ZoteroCollection } from './zotero';
export function collectionRows(
  collections: ZoteroCollection[],
  expanded: ReadonlySet<string>,
  filter = '',
) {
  const nodes = new Map(collections.map((c) => [c.key, c])),
    parents = new Map<string, string | null>(),
    done = new Set<string>();
  for (const c of nodes.values())
    parents.set(c.key, c.parent && nodes.has(c.parent) && c.parent !== c.key ? c.parent : null);
  // Missing parents can occur on a partially loaded page. Keep those folders
  // accessible, and break malformed cycles without recursive tree traversal.
  for (const key of nodes.keys()) {
    const path = new Set<string>();
    let cursor: string | null = key;
    while (cursor && !done.has(cursor)) {
      if (path.has(cursor)) {
        parents.set(cursor, null);
        break;
      }
      path.add(cursor);
      cursor = parents.get(cursor) || null;
    }
    for (const key of path) done.add(key);
  }
  const children = new Map<string | null, ZoteroCollection[]>();
  for (const c of nodes.values()) {
    const parent = parents.get(c.key) || null;
    const group = children.get(parent) || [];
    group.push(c);
    children.set(parent, group);
  }
  for (const group of children.values())
    group.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
  const query = filter.trim().toLocaleLowerCase(),
    included = new Set<string>();
  if (query)
    for (const c of nodes.values())
      if (c.name.toLocaleLowerCase().includes(query)) {
        let key: string | null = c.key;
        while (key && !included.has(key)) {
          included.add(key);
          key = parents.get(key) || null;
        }
      }
  const result: {
      collection: ZoteroCollection;
      depth: number;
      parent: string | null;
      expandable: boolean;
      open: boolean;
    }[] = [],
    stack = (children.get(null) || [])
      .slice()
      .reverse()
      .map((c) => ({ c, depth: 0 }));
  while (stack.length) {
    const { c, depth } = stack.pop()!;
    if (query && !included.has(c.key)) continue;
    const nested = children.get(c.key) || [],
      open = query ? true : expanded.has(c.key);
    result.push({
      collection: c,
      depth,
      parent: parents.get(c.key) || null,
      expandable: nested.length > 0,
      open,
    });
    if (open)
      for (let i = nested.length - 1; i >= 0; i--) stack.push({ c: nested[i], depth: depth + 1 });
  }
  return result;
}
