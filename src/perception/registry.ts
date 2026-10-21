/** Refs stay stable for one main-frame document and are never reused until it navigates. */
export class RefRegistry {
  private readonly byBackend = new Map<number, string>();
  private readonly byRef = new Map<string, number>();
  private next = 1;

  refFor(backendNodeId: number): string {
    const existing = this.byBackend.get(backendNodeId);
    if (existing) return existing;
    const ref = `e${this.next}`;
    this.next += 1;
    this.byBackend.set(backendNodeId, ref);
    this.byRef.set(ref, backendNodeId);
    return ref;
  }

  /** A line still needs a ref, but the AX node has no backend id so actions cannot target it. */
  anonymous(): string {
    return this.allocateUnbound();
  }

  allocateUnbound(): string {
    const ref = `e${this.next}`;
    this.next += 1;
    return ref;
  }

  resolve(ref: string): number | undefined {
    return this.byRef.get(ref);
  }

  reset(): void {
    this.byBackend.clear();
    this.byRef.clear();
    this.next = 1;
  }
}
