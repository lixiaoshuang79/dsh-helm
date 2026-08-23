import { describe, expect, it } from 'vitest'
import {
  configPaths,
  currentOs,
  launchdPlist,
  systemdUnit,
  windowsTaskXml,
  serviceCommands,
  DEFAULT_PORTS,
} from '../src/index.js'

describe('platform paths', () => {
  it('macOS paths under ~/.dsh/helm', () => {
    const p = configPaths('darwin', '/Users/me')
    expect(p.nodeFile).toBe('/Users/me/.dsh/helm/node.json')
    expect(p.storeFile).toBe('/Users/me/.dsh/helm/store.sqlite3')
  })

  it('Windows paths under LOCALAPPDATA (static, no registry)', () => {
    const p = configPaths('win32', 'C:\\Users\\me')
    expect(p.nodeFile).toContain('dsh-helm\\node.json')
    expect(p.dir).toContain('AppData\\Local')
  })

  it('linux paths follow XDG convention', () => {
    const p = configPaths('linux', '/home/me')
    expect(p.nodeFile).toBe('/home/me/.dsh/helm/node.json')
  })

  it('default ports are 3470/3471/3472', () => {
    expect(DEFAULT_PORTS).toEqual({ mesh: 3470, mcp: 3471, presence: 3472 })
  })
})

describe('service templates', () => {
  it('launchd plist has RunAtLoad + KeepAlive and agent command', () => {
    const plist = launchdPlist('com.dsh-helm.agent', '/usr/local/bin/node', '/Users/me/dsh-helm/agent.mjs', '/Users/me/.dsh/helm/logs', { HTTPS_PROXY: 'http://127.0.0.1:7897' })
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(plist).toContain('/Users/me/dsh-helm/agent.mjs')
    expect(plist).toContain('HTTPS_PROXY')
    expect(plist).not.toContain('${') // no template interpolation leftovers
  })

  it('windows task xml restarts on failure and runs at logon', () => {
    const xml = windowsTaskXml('dsh-helm-node-agent', 'C:\\node\\node.exe', 'C:\\dsh-helm\\agent.mjs', 'C:\\dsh-helm')
    expect(xml).toContain('LogonTrigger')
    expect(xml).toContain('RestartOnFailure')
    expect(xml).toContain('node.exe')
    expect(xml).not.toContain('${')
  })

  it('systemd unit restarts always', () => {
    const unit = systemdUnit('dsh-helm node agent', '/usr/bin/node', '/home/me/agent.mjs', '/home/me/logs')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=default.target')
  })

  it('serviceCommands returns per-OS templates', () => {
    const mac = serviceCommands('darwin', { label: 'com.dsh-helm.agent', nodeJsPath: '/n', agentCliPath: '/a.mjs', logDir: '/l', workDir: '/w' })
    expect(mac.install).toContain('launchctl bootstrap')
    expect(mac.uninstall).toContain('launchctl bootout')
    const win = serviceCommands('win32', { label: 'x', nodeJsPath: 'C:\\n', agentCliPath: 'C:\\a.mjs', logDir: 'C:\\l', workDir: 'C:\\w' })
    expect(win.install).toContain('schtasks /Create')
    const linux = serviceCommands('linux', { label: 'x', nodeJsPath: '/n', agentCliPath: '/a.mjs', logDir: '/l', workDir: '/w' })
    expect(linux.install).toContain('systemctl --user enable')
  })

  it('currentOs returns a valid value', () => {
    expect(['darwin', 'win32', 'linux']).toContain(currentOs())
  })
})