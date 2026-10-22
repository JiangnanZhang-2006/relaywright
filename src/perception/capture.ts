import type { CDPSession } from 'puppeteer-core';
import type { AdaptedSelect, AxNode, FrameInput, SelectOption } from './snapshot.js';
import { INSPECT_EXPRESSION } from './inspect-script.js';

interface Remote {
  type?: string;
  subtype?: string;
  value?: unknown;
  objectId?: string;
  description?: string;
}

interface Property {
  name: string;
  value?: Remote;
}

interface DomNode {
  backendNodeId: number;
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

interface FrameTreeNode {
  frame: { id: string; name?: string; url: string };
  childFrames?: FrameTreeNode[];
}

export interface CapturedTree {
  label: string;
  name: string;
  url: string;
  outOfProcess: boolean;
  nodes: AxNode[];
  passwordBackendNodeIds: Set<number>;
  clickableBackendNodeIds: Set<number>;
  clickableLabels: Map<number, string>;
  adaptedSelects: AdaptedSelect[];
}

export async function loadDocument(cdp: CDPSession): Promise<{ main: CapturedTree; frames: FrameInput[] }> {
  await cdp.send('Accessibility.enable').catch(() => undefined);
  const listed = await cdp.send('Page.getFrameTree');
  const frameTree = listed.frameTree as FrameTreeNode;
  const main = await captureFrame(cdp, frameTree.frame.id, frameTree.frame.name ?? '', frameTree.frame.url, true);
  const frames: FrameInput[] = [];
  for (const child of frameTree.childFrames ?? []) await appendChild(cdp, child, frames);
  return { main, frames };
}

async function appendChild(cdp: CDPSession, tree: FrameTreeNode, into: FrameInput[]): Promise<void> {
  const captured = await captureFrame(cdp, tree.frame.id, tree.frame.name ?? '', tree.frame.url, false);
  into.push(toFrameInput(captured));
  if (captured.outOfProcess) return;
  for (const child of tree.childFrames ?? []) await appendChild(cdp, child, into);
}

function toFrameInput(tree: CapturedTree): FrameInput {
  if (tree.outOfProcess) return { label: tree.label, name: tree.name, url: tree.url, outOfProcess: true };
  return {
    label: tree.label,
    name: tree.name,
    url: tree.url,
    nodes: tree.nodes,
    passwordBackendNodeIds: tree.passwordBackendNodeIds,
    clickableBackendNodeIds: tree.clickableBackendNodeIds,
    clickableLabels: tree.clickableLabels,
    adaptedSelects: tree.adaptedSelects,
  };
}

async function captureFrame(
  cdp: CDPSession,
  frameId: string,
  name: string,
  url: string,
  isMain: boolean,
): Promise<CapturedTree> {
  const label = name.trim() || url || 'frame';
  let nodes: AxNode[];
  try {
    nodes = await axTree(cdp, isMain ? null : frameId);
  } catch (err) {
    if (isMain) throw err;
    return emptyTree(url || label, true, name, url);
  }
  try {
    const detected = await inspectFrame(cdp, frameId);
    return {
      label,
      name: name.trim(),
      url,
      outOfProcess: false,
      nodes,
      ...detected,
    };
  } catch (err) {
    if (isMain) throw err;
    return emptyTree(url || label, true, name, url);
  }
}

function emptyTree(label: string, outOfProcess: boolean, name = '', url = ''): CapturedTree {
  return {
    label,
    name: name.trim(),
    url,
    outOfProcess,
    nodes: [],
    passwordBackendNodeIds: new Set(),
    clickableBackendNodeIds: new Set(),
    clickableLabels: new Map(),
    adaptedSelects: [],
  };
}

async function axTree(cdp: CDPSession, frameId: string | null): Promise<AxNode[]> {
  const result = frameId
    ? await cdp.send('Accessibility.getFullAXTree', { frameId })
    : await cdp.send('Accessibility.getFullAXTree');
  return result.nodes as unknown as AxNode[];
}

async function inspectFrame(cdp: CDPSession, frameId: string): Promise<Omit<CapturedTree, 'label' | 'outOfProcess' | 'nodes' | 'name' | 'url'>> {
  const world = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'relaywright' });
  const evaluated = await cdp.send('Runtime.evaluate', {
    expression: INSPECT_EXPRESSION,
    contextId: world.executionContextId,
    returnByValue: false,
  });
  if (evaluated.exceptionDetails) {
    const details = evaluated.exceptionDetails as { text?: string; exception?: { description?: string } };
    throw new Error(details.exception?.description || details.text || 'Page inspect failed');
  }
  const rootId = evaluated.result.objectId;
  if (!rootId) throw new Error('Page inspect did not return an object');
  const release: string[] = [rootId];
  try {
    const rootProps = await properties(cdp, rootId);
    const texts = parseStrings(stringProp(rootProps, 'clickableTextJson'));
    const clickableObjects = await indexedObjects(cdp, objectProp(rootProps, 'clickables'), release);
    const passwordObjects = await indexedObjects(cdp, objectProp(rootProps, 'passwords'), release);
    const selectObjects = await indexedObjects(cdp, objectProp(rootProps, 'selects'), release);

    const clickableBackendNodeIds = new Set<number>();
    const clickableLabels = new Map<number, string>();
    for (let index = 0; index < clickableObjects.length; index += 1) {
      const objectId = clickableObjects[index];
      if (!objectId) continue;
      const backend = await backendOf(cdp, objectId);
      if (backend === null) continue;
      clickableBackendNodeIds.add(backend);
      clickableLabels.set(backend, texts[index] ?? '');
    }

    const passwordBackendNodeIds = new Set<number>();
    for (const objectId of passwordObjects) {
      if (!objectId) continue;
      const backend = await backendOf(cdp, objectId);
      if (backend !== null) passwordBackendNodeIds.add(backend);
    }

    const adaptedSelects: AdaptedSelect[] = [];
    for (const objectId of selectObjects) {
      if (!objectId) continue;
      const adapted = await readAdapted(cdp, objectId, release);
      if (adapted) adaptedSelects.push(adapted);
    }

    return { passwordBackendNodeIds, clickableBackendNodeIds, clickableLabels, adaptedSelects };
  } finally {
    await Promise.all(release.map((objectId) => cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined)));
  }
}

async function readAdapted(cdp: CDPSession, objectId: string, release: string[]): Promise<AdaptedSelect | null> {
  const props = await properties(cdp, objectId);
  const selectId = objectProp(props, 'select');
  const widgetId = objectProp(props, 'widget');
  if (!selectId || !widgetId) return null;
  release.push(selectId, widgetId);
  const selectBackend = await backendOf(cdp, selectId);
  const widgetBackend = await backendOf(cdp, widgetId);
  if (selectBackend === null || widgetBackend === null) return null;
  const subtree = await subtreeIds(cdp, widgetId);
  return {
    selectBackendNodeId: selectBackend,
    widgetBackendNodeId: widgetBackend,
    subtreeBackendNodeIds: subtree,
    label: stringProp(props, 'label'),
    selectedText: stringProp(props, 'selectedText'),
    options: parseOptions(stringProp(props, 'optionsJson')),
  };
}

async function indexedObjects(cdp: CDPSession, objectId: string | null, release: string[]): Promise<string[]> {
  if (!objectId) return [];
  release.push(objectId);
  const props = await properties(cdp, objectId);
  return props
    .filter((property) => /^\d+$/.test(property.name) && property.value?.objectId)
    .sort((left, right) => Number(left.name) - Number(right.name))
    .map((property) => property.value?.objectId ?? '')
    .filter((id) => id.length > 0);
}

async function properties(cdp: CDPSession, objectId: string): Promise<Property[]> {
  const result = await cdp.send('Runtime.getProperties', { objectId, ownProperties: true });
  return result.result as Property[];
}

function objectProp(props: Property[], name: string): string | null {
  return props.find((property) => property.name === name)?.value?.objectId ?? null;
}

function stringProp(props: Property[], name: string): string {
  const value = props.find((property) => property.name === name)?.value?.value;
  return typeof value === 'string' ? value : '';
}

async function backendOf(cdp: CDPSession, objectId: string): Promise<number | null> {
  try {
    const described = await cdp.send('DOM.describeNode', { objectId });
    return described.node.backendNodeId;
  } catch {
    return null;
  }
}

async function subtreeIds(cdp: CDPSession, objectId: string): Promise<number[]> {
  const described = await cdp.send('DOM.describeNode', { objectId, depth: -1 });
  const ids: number[] = [];
  const walk = (node: DomNode): void => {
    ids.push(node.backendNodeId);
    for (const child of node.children ?? []) walk(child);
    for (const shadow of node.shadowRoots ?? []) walk(shadow);
  };
  walk(described.node as unknown as DomNode);
  return ids;
}

function parseStrings(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => (typeof item === 'string' ? item : ''));
  } catch {
    return [];
  }
}

function parseOptions(json: string): SelectOption[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const options: SelectOption[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const record = item as { value?: unknown; text?: unknown };
      options.push({ value: String(record.value ?? ''), text: String(record.text ?? '') });
    }
    return options;
  } catch {
    return [];
  }
}
