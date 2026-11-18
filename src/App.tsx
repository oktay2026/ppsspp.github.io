import { useEffect, useRef } from 'react';
import appShellHtml from './app-shell.html?raw';
import { bootstrapPpssppRuntime } from './ppsspp-runtime';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!container.dataset['mounted']) {
      container.innerHTML = appShellHtml;
      container.dataset['mounted'] = '1';
    }
    void bootstrapPpssppRuntime().catch((error: unknown) => {
      console.error('PPSSPP Web bootstrap failed:', error);
    });
  }, []);

  return <div ref={containerRef} style={{ display: 'contents' }} />;
}
