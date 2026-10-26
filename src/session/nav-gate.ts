import type { Page } from 'puppeteer-core';
import type { NavigationDecision } from './allowlist.js';

/** Block top-level document loads that the allowlist rejects. Other requests continue. */
export async function armNavigationGate(
  page: Page,
  decide: (url: string) => NavigationDecision,
  onBlock: (domain: string) => void,
): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    void (async () => {
      try {
        const topDocument = request.isNavigationRequest() && request.frame() === page.mainFrame() && request.resourceType() === 'document';
        if (!topDocument) {
          await request.continue();
          return;
        }
        const decision = decide(request.url());
        if (decision.ok) {
          await request.continue();
          return;
        }
        onBlock(decision.domain);
        await request.abort('blockedbyclient');
      } catch {
        await request.continue().catch(() => undefined);
      }
    })();
  });
}
