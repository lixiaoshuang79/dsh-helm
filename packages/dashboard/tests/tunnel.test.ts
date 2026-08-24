import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTunnelPlist, readTunnelIdFromPlist, TUNNEL_PLIST_PATH_DEFAULT } from '../src/tunnel.js'

const PLIST_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dsh-helm.tunnel-client</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/me/dsh-helm/tunnel-client.mjs</string>
    <string>--control-plane.tunnel-id</string>
    <string>tunnel_aaaa1111bbbbcccc</string>
    <string>--mcp.server-url</string>
    <string>http://127.0.0.1:3471/mcp</string>
  </array>
</dict>
</plist>
`

const tmpDirs: string[] = []

function tempPlist(xml: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-dashboard-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'tunnel-client.plist')
  writeFileSync(file, xml, 'utf8')
  return file
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseTunnelPlist', () => {
  it('extracts the tunnel id and mcp url from ProgramArguments', () => {
    const info = parseTunnelPlist(PLIST_FIXTURE)
    expect(info.tunnelId).toBe('tunnel_aaaa1111bbbbcccc')
    expect(info.mcpServerUrl).toBe('http://127.0.0.1:3471/mcp')
  })

  it('returns nulls when the plist has no tunnel id', () => {
    const noId = PLIST_FIXTURE.replace(
      /<string>--control-plane\.tunnel-id<\/string>\s*<string>tunnel_[^<]+<\/string>/,
      '',
    )
    const info = parseTunnelPlist(noId)
    expect(info.tunnelId).toBeNull()
    expect(info.mcpServerUrl).toBe('http://127.0.0.1:3471/mcp')
  })

  it('returns nulls for a plist without ProgramArguments', () => {
    const bare = '<plist version="1.0"><dict><key>Label</key><string>x</string></dict></plist>'
    expect(parseTunnelPlist(bare)).toEqual({ tunnelId: null, mcpServerUrl: null })
  })

  it('returns nulls for invalid XML', () => {
    expect(parseTunnelPlist('not xml at all')).toEqual({ tunnelId: null, mcpServerUrl: null })
  })
})

describe('readTunnelIdFromPlist', () => {
  it('reads the tunnel id from a plist file', () => {
    expect(readTunnelIdFromPlist(tempPlist(PLIST_FIXTURE))).toBe('tunnel_aaaa1111bbbbcccc')
  })

  it('returns null for a plist file without a tunnel id', () => {
    const noId = PLIST_FIXTURE.replace(/<string>--control-plane\.tunnel-id<\/string>\s*<string>tunnel_[^<]+<\/string>/, '')
    expect(readTunnelIdFromPlist(tempPlist(noId))).toBeNull()
  })

  it('returns null when the file does not exist', () => {
    expect(readTunnelIdFromPlist('/nonexistent/com.dsh-helm.tunnel-client.plist')).toBeNull()
  })
})

describe('TUNNEL_PLIST_PATH_DEFAULT', () => {
  it('expands ~ to the home directory', () => {
    expect(TUNNEL_PLIST_PATH_DEFAULT).toBe(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.dsh-helm.tunnel-client.plist'))
    expect(TUNNEL_PLIST_PATH_DEFAULT.startsWith(os.homedir())).toBe(true)
  })
})
