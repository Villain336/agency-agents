/** Map a path to a shard name by longest matching prefix; unmatched paths belong to "main". */
export function shardOf(path: string, shards: Record<string, string[]>): string {
  let best = "main";
  let len = -1;
  for (const [name, prefixes] of Object.entries(shards))
    for (const p of prefixes) if (path.startsWith(p) && p.length > len) ((best = name), (len = p.length));
  return best;
}
