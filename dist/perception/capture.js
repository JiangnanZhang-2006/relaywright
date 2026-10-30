import { INSPECT_EXPRESSION } from './inspect-script.js';
export async function loadDocument(cdp) {
    await cdp.send('Accessibility.enable').catch(() => undefined);
    const listed = await cdp.send('Page.getFrameTree');
    const frameTree = listed.frameTree;
    const main = await captureFrame(cdp, frameTree.frame.id, frameTree.frame.name ?? '', frameTree.frame.url, true);
    const frames = [];
    for (const child of frameTree.childFrames ?? [])
        await appendChild(cdp, child, frames);
    return { main, frames };
}
async function appendChild(cdp, tree, into) {
    const captured = await captureFrame(cdp, tree.frame.id, tree.frame.name ?? '', tree.frame.url, false);
    into.push(toFrameInput(captured));
    if (captured.outOfProcess)
        return;
    for (const child of tree.childFrames ?? [])
        await appendChild(cdp, child, into);
}
function toFrameInput(tree) {
    if (tree.outOfProcess)
        return { label: tree.label, name: tree.name, url: tree.url, outOfProcess: true };
    return {
        label: tree.label,
        name: tree.name,
        url: tree.url,
        nodes: tree.nodes,
        passwordBackendNodeIds: tree.passwordBackendNodeIds,
        clickableBackendNodeIds: tree.clickableBackendNodeIds,
        clickableLabels: tree.clickableLabels,
        controlNames: tree.controlNames,
        visiblePassword: tree.visiblePassword,
        adaptedSelects: tree.adaptedSelects,
    };
}
async function captureFrame(cdp, frameId, name, url, isMain) {
    const label = name.trim() || url || 'frame';
    let nodes;
    try {
        nodes = await axTree(cdp, isMain ? null : frameId);
    }
    catch (err) {
        if (isMain)
            throw err;
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
    }
    catch (err) {
        if (isMain)
            throw err;
        return emptyTree(url || label, true, name, url);
    }
}
function emptyTree(label, outOfProcess, name = '', url = '') {
    return {
        label,
        name: name.trim(),
        url,
        outOfProcess,
        nodes: [],
        passwordBackendNodeIds: new Set(),
        clickableBackendNodeIds: new Set(),
        clickableLabels: new Map(),
        controlNames: new Map(),
        visiblePassword: false,
        adaptedSelects: [],
    };
}
async function axTree(cdp, frameId) {
    const result = frameId
        ? await cdp.send('Accessibility.getFullAXTree', { frameId })
        : await cdp.send('Accessibility.getFullAXTree');
    return result.nodes;
}
async function inspectFrame(cdp, frameId) {
    const world = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'relaywright' });
    const evaluated = await cdp.send('Runtime.evaluate', {
        expression: INSPECT_EXPRESSION,
        contextId: world.executionContextId,
        returnByValue: false,
    });
    if (evaluated.exceptionDetails) {
        const details = evaluated.exceptionDetails;
        throw new Error(details.exception?.description || details.text || 'Page inspect failed');
    }
    const rootId = evaluated.result.objectId;
    if (!rootId)
        throw new Error('Page inspect did not return an object');
    const release = [rootId];
    try {
        const rootProps = await properties(cdp, rootId);
        const texts = parseStrings(stringProp(rootProps, 'clickableTextJson'));
        const namedTexts = parseStrings(stringProp(rootProps, 'namedTextJson'));
        const clickableObjects = await indexedObjects(cdp, objectProp(rootProps, 'clickables'), release);
        const passwordObjects = await indexedObjects(cdp, objectProp(rootProps, 'passwords'), release);
        const namedObjects = await indexedObjects(cdp, objectProp(rootProps, 'named'), release);
        const selectObjects = await indexedObjects(cdp, objectProp(rootProps, 'selects'), release);
        const clickableBackendNodeIds = new Set();
        const clickableLabels = new Map();
        for (let index = 0; index < clickableObjects.length; index += 1) {
            const objectId = clickableObjects[index];
            if (!objectId)
                continue;
            const backend = await backendOf(cdp, objectId);
            if (backend === null)
                continue;
            clickableBackendNodeIds.add(backend);
            clickableLabels.set(backend, texts[index] ?? '');
        }
        const passwordBackendNodeIds = new Set();
        for (const objectId of passwordObjects) {
            if (!objectId)
                continue;
            const backend = await backendOf(cdp, objectId);
            if (backend !== null)
                passwordBackendNodeIds.add(backend);
        }
        const controlNames = new Map();
        for (let index = 0; index < namedObjects.length; index += 1) {
            const objectId = namedObjects[index];
            if (!objectId)
                continue;
            const backend = await backendOf(cdp, objectId);
            const label = namedTexts[index] ?? '';
            if (backend !== null && label)
                controlNames.set(backend, label);
        }
        const adaptedSelects = [];
        for (const objectId of selectObjects) {
            if (!objectId)
                continue;
            const adapted = await readAdapted(cdp, objectId, release);
            if (adapted)
                adaptedSelects.push(adapted);
        }
        return {
            passwordBackendNodeIds,
            clickableBackendNodeIds,
            clickableLabels,
            controlNames,
            visiblePassword: boolProp(rootProps, 'visiblePassword'),
            adaptedSelects,
        };
    }
    finally {
        await Promise.all(release.map((objectId) => cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined)));
    }
}
async function readAdapted(cdp, objectId, release) {
    const props = await properties(cdp, objectId);
    const selectId = objectProp(props, 'select');
    const widgetId = objectProp(props, 'widget');
    if (!selectId || !widgetId)
        return null;
    release.push(selectId, widgetId);
    const selectBackend = await backendOf(cdp, selectId);
    const widgetBackend = await backendOf(cdp, widgetId);
    if (selectBackend === null || widgetBackend === null)
        return null;
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
async function indexedObjects(cdp, objectId, release) {
    if (!objectId)
        return [];
    release.push(objectId);
    const props = await properties(cdp, objectId);
    return props
        .filter((property) => /^\d+$/.test(property.name) && property.value?.objectId)
        .sort((left, right) => Number(left.name) - Number(right.name))
        .map((property) => property.value?.objectId ?? '')
        .filter((id) => id.length > 0);
}
async function properties(cdp, objectId) {
    const result = await cdp.send('Runtime.getProperties', { objectId, ownProperties: true });
    return result.result;
}
function objectProp(props, name) {
    return props.find((property) => property.name === name)?.value?.objectId ?? null;
}
function stringProp(props, name) {
    const value = props.find((property) => property.name === name)?.value?.value;
    return typeof value === 'string' ? value : '';
}
function boolProp(props, name) {
    return props.find((property) => property.name === name)?.value?.value === true;
}
async function backendOf(cdp, objectId) {
    try {
        const described = await cdp.send('DOM.describeNode', { objectId });
        return described.node.backendNodeId;
    }
    catch {
        return null;
    }
}
async function subtreeIds(cdp, objectId) {
    const described = await cdp.send('DOM.describeNode', { objectId, depth: -1 });
    const ids = [];
    const walk = (node) => {
        ids.push(node.backendNodeId);
        for (const child of node.children ?? [])
            walk(child);
        for (const shadow of node.shadowRoots ?? [])
            walk(shadow);
    };
    walk(described.node);
    return ids;
}
function parseStrings(json) {
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed))
            return [];
        return parsed.map((item) => (typeof item === 'string' ? item : ''));
    }
    catch {
        return [];
    }
}
function parseOptions(json) {
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed))
            return [];
        const options = [];
        for (const item of parsed) {
            if (!item || typeof item !== 'object')
                continue;
            const record = item;
            options.push({ value: String(record.value ?? ''), text: String(record.text ?? '') });
        }
        return options;
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=capture.js.map