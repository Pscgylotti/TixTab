/** Application-work completion, not a GPU fence or proof of whole-system idle. */
export async function waitForPerformanceSettled(page, { quietMs = 800, timeoutMs = 30_000 } = {}) {
  const started = performance.now();
  const state = { revision: null, quietSince: 0, polls: 0, last: null };
  while (performance.now() - started < timeoutMs) {
    const current = await page.evaluate(() => {
      const ledger = window.tixtabPerformance?.snapshot();
      if (!ledger || ledger.schema !== 1)
        throw Error(
          'Completion diagnostics missing: enable tixtab.performance.enabled before reload.',
        );
      const intersects = (el, viewport) => {
        const r = el.getBoundingClientRect(),
          v = viewport?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
            right: innerWidth,
            bottom: innerHeight,
          };
        return (
          r.width > 0 &&
          r.height > 0 &&
          r.right > Math.max(0, v.left) &&
          r.left < Math.min(innerWidth, v.right) &&
          r.bottom > Math.max(0, v.top) &&
          r.top < Math.min(innerHeight, v.bottom)
        );
      };
      let unready = 0,
        visibleBackgrounds = 0;
      for (const host of document.querySelectorAll('[data-pdf-source]')) {
        if (host.dataset.pdfSource === '') continue;
        const view = host.closest('.reading-view,.page-list,.canvas-container');
        if (!intersects(host, view)) continue;
        visibleBackgrounds++;
        const c = host.querySelector('canvas.pdf-layer,canvas.reading-pdf,canvas');
        const expectedNight =
          host.closest('[data-pdf-night]') ?? host.querySelector('[data-pdf-night]');
        if (
          !c ||
          c.width <= 1 ||
          c.height <= 1 ||
          c.dataset.renderedNight !== expectedNight?.dataset.pdfNight
        )
          unready++;
      }
      let tileErrors = 0;
      for (const tile of document.querySelectorAll('.pdf-detail-tile')) {
        if (!intersects(tile, tile.closest('.reading-view,.canvas-container'))) continue;
        if (tile.dataset.error === 'true') tileErrors++;
        if (tile.dataset.ready !== 'true') unready++;
      }
      for (const image of document.querySelectorAll('.placed-object img'))
        if (
          intersects(image, image.closest('.reading-view,.canvas-container')) &&
          (!image.complete || !image.naturalWidth)
        )
          unready++;
      return {
        ledger,
        unready,
        tileErrors,
        visibleBackgrounds,
        busy: !!document.querySelector('.busy-overlay'),
        hidden: document.hidden,
      };
    });
    state.polls++;
    state.last = current;
    const failed = Object.values(current.ledger.stages).reduce((n, stage) => n + stage.failed, 0);
    if (failed || current.tileErrors)
      throw Error(`Workflow stage failed: ${JSON.stringify(current)}`);
    const ready =
      !current.hidden && !current.busy && !current.unready && current.ledger.pending === 0;
    if (!ready || state.revision !== current.ledger.revision) {
      state.quietSince = performance.now();
      state.revision = current.ledger.revision;
    } else if (performance.now() - state.quietSince >= quietMs) {
      // Allow the last state commit and copy to reach the compositor, while
      // preserving the revision observed before these frames.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const after = await page.evaluate(() => window.tixtabPerformance.snapshot());
      if (!after.pending && after.revision === current.ledger.revision)
        return {
          schema: 1,
          waitMs: performance.now() - started,
          quietMs,
          polls: state.polls,
          visibleBackgrounds: current.visibleBackgrounds,
          ledger: after,
        };
      state.quietSince = performance.now();
      state.revision = after.revision;
    }
    await page.waitForTimeout(100);
  }
  throw Error(`Workflow completion deadline exceeded: ${JSON.stringify(state.last)}`);
}
