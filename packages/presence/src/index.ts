export {
  ManualPresenceProvider,
  CompositePresenceProvider,
} from './providers.js'
export type { PresenceProvider, ManualPresenceOptions } from './providers.js'
export { DesktopSidecarPresenceProvider } from './desktop.js'
export type { DesktopSidecarOptions } from './desktop.js'
export { WindowsDesktopPresenceProvider, WINDOWS_FOREGROUND_PS } from './windows.js'
export type { WindowsAdapterOptions } from './windows.js'
export {
  browserExtensionFiles,
  BROWSER_EXTENSION_MANIFEST,
  BROWSER_EXTENSION_BACKGROUND,
  BROWSER_EXTENSION_CONTENT,
} from './browser.js'
export { PresenceListener, ListenerPresenceProvider } from './listener.js'
export type { PresenceListenerOptions } from './listener.js'
