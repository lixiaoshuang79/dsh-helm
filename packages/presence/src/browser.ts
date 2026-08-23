/**
 * Browser helper scaffold: a Chrome/Edge (MV3) extension that reports
 * chatgpt.com focus to the local presence endpoint.
 *
 * The extension talks only to 127.0.0.1 (host_permissions limited to the
 * local hub); the node agent runs a tiny HTTP listener (see listener.ts) that
 * accepts these reports and forwards them as presence claims. This gives the
 * hub a 'browser' source when the human is looking at ChatGPT in a browser.
 *
 * Files emitted (scaffold/):
 *   manifest.json          - MV3, host_permissions 127.0.0.1:<port>
 *   background.js          - focus tracking via tabs.onActivated
 *   content.js             - page visibility/focus heartbeat
 */

export const BROWSER_EXTENSION_MANIFEST = (port: number) => ({
  manifest_version: 3,
  name: 'dsh-helm presence',
  version: '0.1.0',
  description: 'Reports chatgpt.com focus to the local dsh-helm control plane.',
  permissions: ['tabs'],
  host_permissions: [`http://127.0.0.1:${port}/*`],
  background: { service_worker: 'background.js' },
  content_scripts: [
    {
      matches: ['https://chatgpt.com/*'],
      js: ['content.js'],
      run_at: 'document_idle',
    },
  ],
})

export const BROWSER_EXTENSION_BACKGROUND = (port: number, endpoint = 'presence/browser') => `
const ENDPOINT = 'http://127.0.0.1:${port}/${endpoint}'
let active = false

function report() {
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'browser', confidence: 0.95, pinned: false }),
  }).catch(() => {})
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    const url = tab?.url ?? ''
    active = url.startsWith('https://chatgpt.com')
    if (active) report()
  })
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) { active = false; return }
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const url = tabs[0]?.url ?? ''
    active = url.startsWith('https://chatgpt.com')
    if (active) report()
  })
})

// Heartbeat while active (presence TTL is 60s; renew every 20s).
setInterval(() => { if (active) report() }, 20000)
`

export const BROWSER_EXTENSION_CONTENT = `
// Heartbeat from the page itself while visible + focused.
let visible = document.visibilityState === 'visible'
document.addEventListener('visibilitychange', () => {
  visible = document.visibilityState === 'visible'
  if (visible) reportPage()
})
window.addEventListener('focus', () => reportPage())
function reportPage() {
  fetch('http://127.0.0.1:3470/presence/browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'browser', confidence: 0.95, pinned: false }),
  }).catch(() => {})
}
setInterval(() => { if (visible) reportPage() }, 20000)
`

/** Emit the browser extension scaffold into a directory. */
export function browserExtensionFiles(port: number, endpoint = 'presence/browser'): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(BROWSER_EXTENSION_MANIFEST(port), null, 2),
    'background.js': BROWSER_EXTENSION_BACKGROUND(port, endpoint),
    'content.js': BROWSER_EXTENSION_CONTENT,
    'README.md': `# dsh-helm browser presence helper

Load this directory as an unpacked extension (chrome://extensions -> Developer mode
-> Load unpacked). It reports chatgpt.com focus to the local control plane
(http://127.0.0.1:${port}/${endpoint}) so the hub knows the human is working in the
browser. Loopback only; no remote hosts are contacted.
`,
  }
}
