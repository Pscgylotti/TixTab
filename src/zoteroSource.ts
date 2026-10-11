export type ZoteroSource = {
  library: string;
  key: string;
  parentKey?: string;
  serverId: string;
  title: string;
};
export function validZoteroSource(value: unknown): value is ZoteroSource {
  if (!value || typeof value !== 'object') return false;
  const v = value as ZoteroSource;
  return (
    typeof v.library === 'string' &&
    /^(users\/0|groups\/[1-9][0-9]{0,14})$/.test(v.library) &&
    typeof v.key === 'string' &&
    /^[A-Z0-9]{8}$/.test(v.key) &&
    (v.parentKey === undefined ||
      (typeof v.parentKey === 'string' && /^[A-Z0-9]{8}$/.test(v.parentKey))) &&
    typeof v.serverId === 'string' &&
    /^[\w-]{0,100}$/.test(v.serverId) &&
    typeof v.title === 'string' &&
    v.title.length <= 2000
  );
}
