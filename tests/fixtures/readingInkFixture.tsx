import { createRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import PageEditor from '../../src/PageEditor';
import { finalInkPath } from '../../src/ink';
import type { Page } from '../../src/model';

// Served only by Vite in the regression test; mounts the actual PageEditor.
export function mountReadingInk(container: HTMLElement, initial: Page) {
  const scroll = document.createElement('div');
  scroll.setAttribute('data-ink-fixture-viewport', '');
  Object.assign(scroll.style, { width: '640px', height: '480px', overflow: 'auto' });
  const content = document.createElement('div');
  scroll.append(content);
  container.append(scroll);
  const root = createRoot(content);
  const viewport = createRef<HTMLDivElement>();
  viewport.current = scroll;
  let update: (page: Page) => void;
  function Fixture() {
    const [page, setPage] = useState(initial);
    update = setPage;
    return (
      <div style={{ position: 'relative', width: page.width, height: page.height }}>
        <PageEditor
          page={page}
          pdf={null}
          tool="hand"
          color="#112233"
          size={3}
          zoom={1}
          onChange={setPage}
          onDiagnostic={() => {}}
          onContext={() => {}}
          onEditObject={() => {}}
          focusObjectId={null}
          viewport={viewport}
          reading
        />
      </div>
    );
  }
  flushSync(() => root.render(<Fixture />));
  return {
    update(page: Page) {
      flushSync(() => update(page));
    },
    unmount() {
      flushSync(() => root.unmount());
      scroll.remove();
    },
    path: finalInkPath,
  };
}
