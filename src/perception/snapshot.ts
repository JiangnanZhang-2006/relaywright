import { RefRegistry } from './registry.js';

export const DEFAULT_MAX_SNAPSHOT_LINES = 300;
export const DEFAULT_MAX_TABLE_ROWS = 5;
const CLICKABLE_TEXT_MAX = 80;
const TABLE_ROW_MAX = 200;

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

const TABLE_ROLES = new Set(['table', 'grid', 'treegrid']);
const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);
const CALLOUT_ROLES = new Set(['alert', 'status', 'dialog']);

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

export interface SelectOption {
  value: string;
  text: string;
}

export interface AdaptedSelect {
  selectBackendNodeId: number;
  widgetBackendNodeId: number;
  /** Includes the widget root. Every AX node in this set is suppressed. */
  subtreeBackendNodeIds: readonly number[];
  label: string;
  selectedText: string;
  options: readonly SelectOption[];
}

export interface FrameRef {
  name: string;
  url: string;
}

export interface ModelItem {
  ref: string;
  backend: number;
  role: string;
  name: string;
  value?: string;
  text?: string;
  label?: string;
  frame?: FrameRef;
  redacted?: boolean;
}

export interface TableFact {
  name: string;
  rows: number;
  frame?: FrameRef;
}

export interface FrameInput {
  label: string;
  name?: string;
  url?: string;
  outOfProcess?: boolean;
  nodes?: readonly AxNode[];
  passwordBackendNodeIds?: ReadonlySet<number>;
  clickableBackendNodeIds?: ReadonlySet<number>;
  /** DOM text used only when the clickable element has no AX node. */
  clickableLabels?: ReadonlyMap<number, string>;
  adaptedSelects?: readonly AdaptedSelect[];
}

export interface SnapshotInput {
  title: string;
  url: string;
  nodes: readonly AxNode[];
  passwordBackendNodeIds?: ReadonlySet<number>;
  maxLines?: number;
  maxRows?: number;
  clickableBackendNodeIds?: ReadonlySet<number>;
  clickableLabels?: ReadonlyMap<number, string>;
  adaptedSelects?: readonly AdaptedSelect[];
  frames?: readonly FrameInput[];
  registry?: RefRegistry;
}

export interface RenderResult {
  header: string;
  lines: string[];
  text: string;
  items: ModelItem[];
  tables: TableFact[];
}

interface TreeIndex {
  childrenOf: (node: AxNode) => AxNode[];
  roots: AxNode[];
}

interface PreparedTable {
  summary: string;
  rowLines: string[];
  omitted: Set<string>;
  rows: number;
}

export function renderSnapshot(input: SnapshotInput): string {
  return renderSnapshotParts(input).text;
}

export function renderSnapshotParts(input: SnapshotInput): RenderResult {
  const header = pageHeader(input.title, input.url);
  const body = renderBody(input);
  const maxLines = input.maxLines ?? DEFAULT_MAX_SNAPSHOT_LINES;
  return { header, lines: body.lines, text: formatLines(header, body.lines, maxLines), items: body.items, tables: body.tables };
}

export function pageHeader(title: string, url: string): string {
  return `page: ${compact(title)}  url: ${compact(url)}`;
}

export function formatLines(header: string, body: readonly string[], maxLines = DEFAULT_MAX_SNAPSHOT_LINES): string {
  const shown = body.slice(0, maxLines);
  const omitted = body.length - shown.length;
  const lines = omitted > 0 ? [...shown, `… ${omitted} more`] : [...shown];
  return [header, ...lines].join('\n');
}

function renderBody(input: SnapshotInput): { lines: string[]; items: ModelItem[]; tables: TableFact[] } {
  const lines: string[] = [];
  const items: ModelItem[] = [];
  const tables: TableFact[] = [];
  const assign = refAssigner(input.registry);
  renderTree(
    lines,
    items,
    tables,
    input.nodes,
    {
      passwordBackendNodeIds: input.passwordBackendNodeIds ?? new Set<number>(),
      clickableBackendNodeIds: input.clickableBackendNodeIds ?? new Set<number>(),
      clickableLabels: input.clickableLabels ?? new Map<number, string>(),
      adaptedSelects: input.adaptedSelects ?? [],
      maxRows: input.maxRows ?? DEFAULT_MAX_TABLE_ROWS,
    },
    assign,
    undefined,
  );
  for (const frame of input.frames ?? []) {
    const suffix = frame.outOfProcess ? ' (out-of-process, not inspected)' : '';
    lines.push(`--- frame ${quote(frame.label)}${suffix}`);
    if (frame.outOfProcess) continue;
    const frameRef = frame.name || frame.url ? { name: frame.name ?? '', url: frame.url ?? '' } : undefined;
    renderTree(
      lines,
      items,
      tables,
      frame.nodes ?? [],
      {
        passwordBackendNodeIds: frame.passwordBackendNodeIds ?? new Set<number>(),
        clickableBackendNodeIds: frame.clickableBackendNodeIds ?? new Set<number>(),
        clickableLabels: frame.clickableLabels ?? new Map<number, string>(),
        adaptedSelects: frame.adaptedSelects ?? [],
        maxRows: input.maxRows ?? DEFAULT_MAX_TABLE_ROWS,
      },
      assign,
      frameRef,
    );
  }
  return { lines, items, tables };
}

interface TreeOptions {
  passwordBackendNodeIds: ReadonlySet<number>;
  clickableBackendNodeIds: ReadonlySet<number>;
  clickableLabels: ReadonlyMap<number, string>;
  adaptedSelects: readonly AdaptedSelect[];
  maxRows: number;
}

function renderTree(
  lines: string[],
  items: ModelItem[],
  tableFacts: TableFact[],
  nodes: readonly AxNode[],
  options: TreeOptions,
  assign: (backend: number | undefined) => string,
  frame: FrameRef | undefined,
): void {
  const index = indexTree(nodes);
  const selectIds = new Set(options.adaptedSelects.map((item) => item.selectBackendNodeId));
  const subtreeOwner = new Map<number, AdaptedSelect>();
  for (const adapted of options.adaptedSelects) {
    const ids = adapted.subtreeBackendNodeIds.length > 0 ? adapted.subtreeBackendNodeIds : [adapted.widgetBackendNodeId];
    for (const id of ids) subtreeOwner.set(id, adapted);
  }
  const tables = new Map<string, PreparedTable>();
  const omitted = new Set<string>();
  const remember = (item: ModelItem): void => {
    items.push(frame ? { ...item, frame } : item);
  };
  for (const node of nodes) {
    if (!TABLE_ROLES.has(roleOf(node)) || node.ignored) continue;
    const prepared = prepareTable(node, index, options.maxRows);
    tables.set(node.nodeId, prepared);
    tableFacts.push(frame ? { name: compact(axText(node.name)), rows: prepared.rows, frame } : { name: compact(axText(node.name)), rows: prepared.rows });
    for (const id of prepared.omitted) omitted.add(id);
  }
  const interactiveChild = markInteractive(index, selectIds, subtreeOwner, omitted);
  const placedSelects = new Set<number>();
  const renderedBackends = new Set<number>();
  const seen = new Set<string>();

  const bury = (current: AxNode): void => {
    if (seen.has(current.nodeId)) return;
    seen.add(current.nodeId);
    for (const child of index.childrenOf(current)) bury(child);
  };

  const visit = (node: AxNode, ancestorInteractive: boolean): void => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    if (omitted.has(node.nodeId)) {
      for (const child of index.childrenOf(node)) bury(child);
      return;
    }

    const backend = node.backendDOMNodeId;
    if (backend !== undefined && selectIds.has(backend)) {
      for (const child of index.childrenOf(node)) bury(child);
      return;
    }

    if (backend !== undefined && subtreeOwner.has(backend)) {
      const adapted = subtreeOwner.get(backend);
      if (adapted && !placedSelects.has(adapted.selectBackendNodeId)) {
        const ref = assign(adapted.selectBackendNodeId);
        lines.push(formatCombobox(adapted, ref));
        remember({
          ref,
          backend: adapted.selectBackendNodeId,
          role: 'combobox',
          name: adapted.label,
          label: adapted.label,
          value: compact(adapted.selectedText),
        });
        placedSelects.add(adapted.selectBackendNodeId);
      }
      for (const child of index.childrenOf(node)) bury(child);
      return;
    }

    const role = roleOf(node);
    const interactive = !node.ignored && INTERACTIVE_ROLES.has(role);
    const table = tables.get(node.nodeId);
    if (table && !node.ignored) {
      lines.push(table.summary);
      for (const rowLine of table.rowLines) lines.push(rowLine);
    }

    if (!node.ignored && interactive) {
      const rendered = describeInteractive(node, options.passwordBackendNodeIds);
      if (rendered) {
        const ref = assign(backend);
        lines.push(formatInteractive(rendered, ref));
        if (backend !== undefined) {
          const redacted = rendered.value === '[redacted]' || isPassword(node, role, options.passwordBackendNodeIds);
          remember({
            ref,
            backend,
            role: rendered.role,
            name: rendered.name,
            ...(rendered.value !== undefined ? { value: rendered.value } : {}),
            ...(rendered.name ? { text: rendered.name } : {}),
            ...(redacted ? { redacted: true } : {}),
          });
          renderedBackends.add(backend);
        }
      }
    } else if (
      backend !== undefined &&
      options.clickableBackendNodeIds.has(backend) &&
      !interactive &&
      !ancestorInteractive &&
      !interactiveChild.get(node.nodeId)
    ) {
      // Ignored generics are still the clickable element; their text lives on StaticText children.
      const text = clickableText(node, index, options.clickableLabels.get(backend));
      if (text) {
        const ref = assign(backend);
        lines.push(`[${ref}] clickable ${quote(text)}`);
        remember({ ref, backend, role: 'clickable', name: text, text });
        renderedBackends.add(backend);
      }
    } else if (!node.ignored && role === 'heading') {
      const name = compact(axText(node.name));
      if (name) lines.push(`${headingTag(node)} ${quote(name)}`);
    } else if (!node.ignored && CALLOUT_ROLES.has(role)) {
      // Live regions often have an empty AX name; the text is on StaticText children.
      const name = compact(axText(node.name)) || staticText(node, index);
      if (name) lines.push(`${role} ${quote(name)}`);
    }

    const nextAncestor = ancestorInteractive || interactive;
    for (const child of index.childrenOf(node)) visit(child, nextAncestor);
  };

  for (const root of index.roots) visit(root, false);
  for (const node of nodes) visit(node, false);

  for (const adapted of options.adaptedSelects) {
    if (placedSelects.has(adapted.selectBackendNodeId)) continue;
    const ref = assign(adapted.selectBackendNodeId);
    lines.push(formatCombobox(adapted, ref));
    remember({
      ref,
      backend: adapted.selectBackendNodeId,
      role: 'combobox',
      name: adapted.label,
      label: adapted.label,
      value: compact(adapted.selectedText),
    });
    placedSelects.add(adapted.selectBackendNodeId);
  }
  for (const backend of options.clickableBackendNodeIds) {
    if (renderedBackends.has(backend) || subtreeOwner.has(backend) || selectIds.has(backend)) continue;
    const text = clip(compact(options.clickableLabels.get(backend) ?? ''), CLICKABLE_TEXT_MAX);
    if (!text) continue;
    const ref = assign(backend);
    lines.push(`[${ref}] clickable ${quote(text)}`);
    remember({ ref, backend, role: 'clickable', name: text, text });
    renderedBackends.add(backend);
  }
}

function refAssigner(registry: RefRegistry | undefined): (backend: number | undefined) => string {
  let local = 0;
  return (backend) => {
    if (registry) {
      if (backend === undefined) return registry.anonymous();
      return registry.refFor(backend);
    }
    local += 1;
    return `e${local}`;
  };
}

function formatCombobox(adapted: AdaptedSelect, ref: string): string {
  const value = compact(adapted.selectedText);
  const options = formatOptionList(adapted.options);
  return `[${ref}] combobox ${quote(adapted.label)} = ${quote(value)} (options: ${options})`;
}

function formatOptionList(options: readonly SelectOption[]): string {
  const texts = options
    .filter((option) => option.value !== '')
    .map((option) => compact(option.text))
    .filter((text) => text.length > 0);
  const shown = texts.slice(0, 8);
  if (texts.length > 8) return `${shown.join(', ')}, … ${texts.length} total`;
  return shown.join(', ');
}

interface InteractiveLine {
  role: string;
  name: string;
  value?: string;
}

function formatInteractive(rendered: InteractiveLine, ref: string): string {
  const name = rendered.name ? ` ${quote(rendered.name)}` : '';
  const value = rendered.value !== undefined ? ` = ${quote(rendered.value)}` : '';
  return `[${ref}] ${rendered.role}${name}${value}`;
}

function describeInteractive(node: AxNode, passwordIds: ReadonlySet<number>): InteractiveLine | null {
  const role = roleOf(node);
  if (!INTERACTIVE_ROLES.has(role)) return null;
  const name = compact(axText(node.name));
  const rawValue = compact(axText(node.value));
  if (isPassword(node, role, passwordIds)) {
    return rawValue ? { role, name, value: '[redacted]' } : { role, name };
  }
  return rawValue ? { role, name, value: rawValue } : { role, name };
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
  if (Number.isInteger(level) && level >= 1 && level <= 6) return `h${level}`;
  return 'heading';
}

function prepareTable(table: AxNode, index: TreeIndex, maxRows: number): PreparedTable {
  const rows = collectRows(table, index);
  const header = rows.find((row) => rowHasColumnHeader(row, index));
  const dataRows = header ? rows.filter((row) => row !== header) : rows;
  const colSource = header ?? dataRows[0];
  const cols = colSource ? rowCells(colSource, index).map((cell) => cellText(cell, index)) : [];
  const rendered = dataRows.slice(0, maxRows);
  const rowLines = rendered.map((row) => {
    const line = `  | ${rowCells(row, index).map((cell) => cellText(cell, index)).join(' | ')} |`;
    return line.length <= TABLE_ROW_MAX ? line : line.slice(0, TABLE_ROW_MAX);
  });
  const omitted = new Set<string>();
  for (const row of dataRows.slice(maxRows)) collectIds(row, index, omitted);
  return {
    summary: `table ${quote(compact(axText(table.name)))} rows=${dataRows.length} cols: ${cols.join(' | ')}`,
    rowLines,
    omitted,
    rows: dataRows.length,
  };
}

function collectRows(table: AxNode, index: TreeIndex): AxNode[] {
  const rows: AxNode[] = [];
  const queue = [...index.childrenOf(table)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const role = roleOf(current);
    if (TABLE_ROLES.has(role)) continue;
    if (role === 'row') {
      rows.push(current);
      continue;
    }
    queue.push(...index.childrenOf(current));
  }
  return rows;
}

function rowHasColumnHeader(row: AxNode, index: TreeIndex): boolean {
  const queue = [...index.childrenOf(row)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const role = roleOf(current);
    if (role === 'columnheader') return true;
    if (role === 'row' || TABLE_ROLES.has(role)) continue;
    queue.push(...index.childrenOf(current));
  }
  return false;
}

function rowCells(row: AxNode, index: TreeIndex): AxNode[] {
  const cells: AxNode[] = [];
  const queue = [...index.childrenOf(row)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const role = roleOf(current);
    if (CELL_ROLES.has(role)) {
      cells.push(current);
      continue;
    }
    if (role === 'row' || TABLE_ROLES.has(role)) continue;
    queue.push(...index.childrenOf(current));
  }
  return cells;
}

function cellText(cell: AxNode, index: TreeIndex): string {
  const name = compact(axText(cell.name));
  if (name) return name;
  return staticText(cell, index);
}

function clickableText(node: AxNode, index: TreeIndex, domLabel: string | undefined): string {
  const name = compact(axText(node.name));
  if (name) return clip(name, CLICKABLE_TEXT_MAX);
  const fromTree = staticText(node, index);
  if (fromTree) return clip(fromTree, CLICKABLE_TEXT_MAX);
  return clip(compact(domLabel ?? ''), CLICKABLE_TEXT_MAX);
}

function staticText(node: AxNode, index: TreeIndex): string {
  const texts: string[] = [];
  const inlines: string[] = [];
  const queue = [...index.childrenOf(node)];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.nodeId)) continue;
    seen.add(current.nodeId);
    const role = roleOf(current);
    if (role === 'statictext') {
      const text = axText(current.name);
      if (text) texts.push(text);
    } else if (role === 'inlinetextbox') {
      const text = axText(current.name);
      if (text) inlines.push(text);
    }
    queue.push(...index.childrenOf(current));
  }
  const parts = texts.length > 0 ? texts : inlines;
  return compact(parts.join(' '));
}

function collectIds(node: AxNode, index: TreeIndex, into: Set<string>): void {
  if (into.has(node.nodeId)) return;
  into.add(node.nodeId);
  for (const child of index.childrenOf(node)) collectIds(child, index, into);
}

function markInteractive(
  index: TreeIndex,
  selectIds: ReadonlySet<number>,
  subtreeOwner: ReadonlyMap<number, AdaptedSelect>,
  omitted: ReadonlySet<string>,
): Map<string, boolean> {
  const interactiveChild = new Map<string, boolean>();
  const seen = new Set<string>();

  const mark = (node: AxNode, suppressed: boolean): boolean => {
    if (seen.has(node.nodeId)) return false;
    seen.add(node.nodeId);
    const backend = node.backendDOMNodeId;
    const suppress =
      suppressed ||
      omitted.has(node.nodeId) ||
      (backend !== undefined && (selectIds.has(backend) || subtreeOwner.has(backend)));
    let childRenders = false;
    for (const child of index.childrenOf(node)) {
      if (mark(child, suppress)) childRenders = true;
    }
    interactiveChild.set(node.nodeId, !suppress && childRenders);
    if (suppress || node.ignored) return suppress ? false : childRenders;
    return INTERACTIVE_ROLES.has(roleOf(node)) || childRenders;
  };

  for (const root of index.roots) mark(root, false);
  return interactiveChild;
}

function indexTree(nodes: readonly AxNode[]): TreeIndex {
  const byId = new Map<string, AxNode>();
  for (const node of nodes) byId.set(node.nodeId, node);
  const childIds = new Map<string, string[]>();
  const referenced = new Set<string>();
  const useChildIds = nodes.some((node) => (node.childIds?.length ?? 0) > 0);
  if (useChildIds) {
    for (const node of nodes) {
      const ids = node.childIds ?? [];
      childIds.set(node.nodeId, ids);
      for (const id of ids) referenced.add(id);
    }
  } else {
    for (const node of nodes) {
      if (!node.parentId) continue;
      const list = childIds.get(node.parentId) ?? [];
      list.push(node.nodeId);
      childIds.set(node.parentId, list);
      referenced.add(node.nodeId);
    }
  }
  const childrenOf = (node: AxNode): AxNode[] => {
    const children: AxNode[] = [];
    for (const id of childIds.get(node.nodeId) ?? []) {
      const child = byId.get(id);
      if (child) children.push(child);
    }
    return children;
  };
  const roots: AxNode[] = [];
  for (const node of nodes) {
    if (!referenced.has(node.nodeId)) roots.push(node);
  }
  return { childrenOf, roots };
}

function roleOf(node: AxNode): string {
  return axText(node.role).toLowerCase();
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

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function quote(value: string): string {
  return `"${compact(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
