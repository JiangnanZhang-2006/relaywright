export interface PointerNode {
  id: string;
  parentId: string | null;
  visible: boolean;
  pointer: boolean;
  directText: string;
  innerText: string;
}

/**
 * When an outermost pointer element has no text of its own, emit sibling pointer
 * descendants with distinct text instead of the container. A single icon+text
 * wrapper returns null so the caller keeps the container.
 */
export function splitPointerSiblings(nodes: readonly PointerNode[], outerId: string): string[] | null {
  const outer = nodes.find((node) => node.id === outerId);
  if (!outer || outer.directText.trim()) return null;
  const byParent = new Map<string, PointerNode[]>();
  for (const node of nodes) {
    if (node.id === outerId || !node.parentId) continue;
    if (!node.visible || !node.pointer) continue;
    const text = node.innerText.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!isDescendant(nodes, node.id, outerId)) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push({ ...node, innerText: text });
    byParent.set(node.parentId, list);
  }
  for (const list of byParent.values()) {
    if (list.length < 2) continue;
    const texts = new Set(list.map((node) => node.innerText));
    if (texts.size !== list.length) continue;
    return list.map((node) => node.id);
  }
  return null;
}

function isDescendant(nodes: readonly PointerNode[], id: string, ancestor: string): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current?.parentId) {
    if (current.parentId === ancestor) return true;
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    current = byId.get(current.parentId);
  }
  return false;
}
