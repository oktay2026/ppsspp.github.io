import { setupNetworkInvites } from './network-invites';
import {
  Activity,
  Award,
  Cloud,
  Download,
  Eye,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  GitFork,
  HardDrive,
  Info,
  Link2,
  Maximize,
  Minimize,
  Monitor,
  PanelRight,
  Play,
  RadioTower,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  Terminal,
  Trash2,
  Upload,
  X,
  createIcons,
} from 'lucide';

const PPSSPP_ICONS = {
  Activity,
  Award,
  Cloud,
  Download,
  Eye,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  GitFork,
  HardDrive,
  Info,
  Link2,
  Maximize,
  Minimize,
  Monitor,
  PanelRight,
  Play,
  RadioTower,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  Terminal,
  Trash2,
  Upload,
  X,
};

const RUNTIME_ASSET_VERSION = '2026-11-08-textures-v1';

let bootPromise: Promise<void> | undefined;

function loadScript(src: string, id: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-runtime-id="${id}"]`);
  if (existing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.defer = true;
    script.dataset['runtimeId'] = id;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.body.appendChild(script);
  });
}

export function bootstrapPpssppRuntime(): Promise<void> {
  bootPromise ??= (async () => {
    createIcons({ icons: PPSSPP_ICONS });
    await loadScript(`adhoc-transport.js?v=${RUNTIME_ASSET_VERSION}`, 'adhoc-transport');
    await loadScript(`demo-library.js?v=${RUNTIME_ASSET_VERSION}`, 'demo-library');
    await loadScript(`texture-packs.js?v=${RUNTIME_ASSET_VERSION}`, 'texture-packs');
    await loadScript(`ppsspp-runtime.js?v=${RUNTIME_ASSET_VERSION}`, 'ppsspp-runtime');
    await loadScript(`console-ui.js?v=${RUNTIME_ASSET_VERSION}`, 'console-ui');
    await loadScript(`shared-sessions.js?v=${RUNTIME_ASSET_VERSION}`, 'shared-sessions');
    setupNetworkInvites(document);
  })();
  return bootPromise;
}
