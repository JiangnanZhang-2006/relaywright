export const DEFAULT_MAX_SNAPSHOT_LINES = 300;

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'option',
  'searchbox',
  'switch',
  'slider',
]);

export interface AxValue {
  type?: string;
  value?: unknown;
}

export interface AxProperty {
  name: string;
  value: AxValue;
}

export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  chromeRole?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: AxProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface SnapshotInput {
  title: string;
  url: string;
  nodes: readonly AxNode[];
  passwordBackendNodeIds?: ReadonlySet<number>;
  maxLines?: number;
}

interface InteractiveLine {
  kind: 'interactive';
  role: string;
  name: string;
  value?: string;
}

interface HeadingLine {
  kind: 'heading';
  tag: string;
  name: string;
}

type RenderedLine = InteractiveLine | HeadingLine;

export function renderSnapshot(input: SnapshotInput): string {
  const limit = input.maxLines ?? DEFAULT_MAX_SNAPSHOT_LINES;
  const passwordIds = input.passwordBackendNodeIds ?? new Set<number>();
  const lines: string[] = [];
  let omitted = 0;
  let ref = 0;

  for (const node of walkOrder(input.nodes)) {
    // Ignored wrappers are skipped, but their children stay in the walk.
    if (node.ignored) continue;
    const rendered = describeNode(node, passwordIds);
    if (!rendered) continue;
    if (lines.length >= limit) {
      omitted += 1;
      continue;
    }
    if (rendered.kind === 'heading') {
      lines.push(`${rendered.tag} ${quote(rendered.name)}`);
      continue;
    }
    ref += 1;
    const name = rendered.name ? ` ${quote(rendered.name)}` : '';
    const value = rendered.value !== undefined ? ` = ${quote(rendered.value)}` : '';
    lines.push(`[e${ref}] ${rendered.role}${name}${value}`);
  }

  const header = `page: ${compact(input.title)}  url: ${compact(input.url)}`;
  if (omitted > 0) lines.push(`… ${omitted} more`);
  return [header, ...lines].join('\n');
}

function describeNode(node: AxNode, passwordIds: ReadonlySet<number>): RenderedLine | null {
  const role = axText(node.role).toLowerCase();
  if (role === 'heading') {
    const name = compact(axText(node.name));
    if (!name) return null;
    return { kind: 'heading', tag: headingTag(node), name };
  }
  if (!INTERACTIVE_ROLES.has(role)) return null;

  const name = compact(axText(node.name));
  const rawValue = compact(axText(node.value));
  if (isPassword(node, role, passwordIds)) {
    return rawValue ? { kind: 'interactive', role, name, value: '[redacted]' } : { kind: 'interactive', role, name };
  }
  return rawValue ? { kind: 'interactive', role, name, value: rawValue } : { kind: 'interactive', role, name };
}

function isPassword(node: AxNode, role: string, passwordIds: ReadonlySet<number>): boolean {
  if (role === 'password' || role.includes('password')) return true;
  const chromeRole = axText(node.chromeRole).toLowerCase();
  if (chromeRole.includes('password')) return true;
  if (node.backendDOMNodeId !== undefined && passwordIds.has(node.backendDOMNodeId)) return true;
  for (const property of node.properties ?? []) {
    const name = property.name.toLowerCase();
    if (name === 'protected' && truthy(property.value?.value)) return true;
    if (name === 'autocomplete' && axText(property.value).toLowerCase().includes('password')) return true;
  }
  return false;
}

function truthy(value: unknown): boolean {
  return value !== false && value !== 'false' && value !== 0 && value !== null && value !== undefined;
}

function headingTag(node: AxNode): string {
  const raw = node.properties?.find((property) => property.name === 'level')?.value?.value;
  const level = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isInteger(level) && level >= 1 && level <= 9) return `h${level}`;
  return 'heading';
}

function walkOrder(nodes: readonly AxNode[]): AxNode[] {
  const byId = new Map<string, AxNode>();
  for (const node of nodes) byId.set(node.nodeId, node);

  const children = new Map<string, string[]>();
  const referenced = new Set<string>();
  const useChildIds = nodes.some((node) => (node.childIds?.length ?? 0) > 0);

  if (useChildIds) {
    for (const node of nodes) {
      const ids = node.childIds ?? [];
      children.set(node.nodeId, ids);
      for (const id of ids) referenced.add(id);
    }
  } else {
    for (const node of nodes) {
      if (!node.parentId) continue;
      const list = children.get(node.parentId) ?? [];
      list.push(node.nodeId);
      children.set(node.parentId, list);
      referenced.add(node.nodeId);
    }
  }

  const ordered: AxNode[] = [];
  const seen = new Set<string>();
  const visit = (node: AxNode): void => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    ordered.push(node);
    for (const id of children.get(node.nodeId) ?? []) {
      const child = byId.get(id);
      if (child) visit(child);
    }
  };

  for (const node of nodes) {
    if (!referenced.has(node.nodeId)) visit(node);
  }
  for (const node of nodes) visit(node);
  return ordered;
}

function axText(value: AxValue | undefined): string {
  if (!value || value.value === undefined || value.value === null) return '';
  if (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean') {
    return String(value.value);
  }
  return '';
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function quote(value: string): string {
  return `"${compact(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
