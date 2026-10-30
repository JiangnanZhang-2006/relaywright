/** Refs stay stable for one main-frame document and are never reused until it navigates. */
export class RefRegistry {
    byBackend = new Map();
    byRef = new Map();
    next = 1;
    refFor(backendNodeId) {
        const existing = this.byBackend.get(backendNodeId);
        if (existing)
            return existing;
        const ref = `e${this.next}`;
        this.next += 1;
        this.byBackend.set(backendNodeId, ref);
        this.byRef.set(ref, backendNodeId);
        return ref;
    }
    /** A line still needs a ref, but the AX node has no backend id so actions cannot target it. */
    anonymous() {
        return this.allocateUnbound();
    }
    allocateUnbound() {
        const ref = `e${this.next}`;
        this.next += 1;
        return ref;
    }
    resolve(ref) {
        return this.byRef.get(ref);
    }
    reset() {
        this.byBackend.clear();
        this.byRef.clear();
        this.next = 1;
    }
}
//# sourceMappingURL=registry.js.map