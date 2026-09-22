/**
 * Small per-item values (rating, read state) live as `prism-*` lines in the
 * item's Extra field: they survive export, sync with Zotero, and never need a
 * database schema of their own.
 */

export function readExtra(item: Zotero.Item, key: string): string | undefined {
  const extra = String(item.getField("extra") || "");
  const match = new RegExp(`^prism-${key}\\s*:\\s*(.*)$`, "mi").exec(extra);
  return match ? match[1].trim() : undefined;
}

export async function writeExtra(
  item: Zotero.Item,
  key: string,
  value: string | null,
) {
  const extra = String(item.getField("extra") || "");
  const pattern = new RegExp(`^prism-${key}\\s*:.*$`, "mi");
  let next: string;
  if (value === null || value === "") {
    next = extra.replace(pattern, "").replace(/\n{2,}/g, "\n").trim();
  } else if (pattern.test(extra)) {
    next = extra.replace(pattern, `prism-${key}: ${value}`);
  } else {
    next = extra ? `${extra}\nprism-${key}: ${value}` : `prism-${key}: ${value}`;
  }
  item.setField("extra", next);
  await item.saveTx({ skipDateModifiedUpdate: true } as any);
}

export function getRating(item: Zotero.Item): number {
  return Math.max(0, Math.min(5, Number(readExtra(item, "rating") || 0)));
}

export async function setRating(item: Zotero.Item, value: number) {
  await writeExtra(item, "rating", value > 0 ? String(value) : null);
}

export function isMarkedRead(item: Zotero.Item): boolean | undefined {
  const value = readExtra(item, "read");
  if (value === undefined) return undefined;
  return value === "1" || value === "true";
}

export async function setMarkedRead(item: Zotero.Item, read: boolean | null) {
  await writeExtra(item, "read", read === null ? null : read ? "1" : "0");
}
