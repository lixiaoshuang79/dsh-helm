import { describe, expect, it } from 'vitest'
import { parseArgs, render, handoffV1, HELP_TEXT } from '../src/cli.js'

describe('parseArgs', () => {
  it('parses command + positional args + flags', () => {
    const a = parseArgs(['route-explain', 'sessions_prompt', '--session-id', 's-1', '--json'])
    expect(a.command).toBe('route-explain')
    expect(a.args).toEqual(['sessions_prompt'])
    expect(a.flags['session-id']).toBe('s-1')
    expect(a.flags['json']).toBe(true)
  })

  it('handles --key=value form', () => {
    const a = parseArgs(['nodes', 'list', '--node-id=n-1'])
    expect(a.command).toBe('nodes')
    expect(a.args).toEqual(['list'])
    expect(a.flags['node-id']).toBe('n-1')
  })

  it('defaults to help for unknown commands', () => {
    const a = parseArgs(['frobnicate'])
    expect(a.command).toBe('help')
  })

  it('init has no extra args', () => {
    const a = parseArgs(['init'])
    expect(a.command).toBe('init')
    expect(a.args).toEqual([])
  })

  it('parses doctor with --hub and --tunnel-health', () => {
    const a = parseArgs(['doctor', '--hub', 'http://127.0.0.1:3471', '--tunnel-health', 'http://127.0.0.1:3468'])
    expect(a.command).toBe('doctor')
    expect(a.args).toEqual([])
    expect(a.flags['hub']).toBe('http://127.0.0.1:3471')
    expect(a.flags['tunnel-health']).toBe('http://127.0.0.1:3468')
  })

  it('parses dashboard with --port', () => {
    const a = parseArgs(['dashboard', '--port', '3481'])
    expect(a.command).toBe('dashboard')
    expect(a.flags['port']).toBe('3481')
  })

  it('parses install', () => {
    const a = parseArgs(['install'])
    expect(a.command).toBe('install')
    expect(a.args).toEqual([])
  })
})

describe('render', () => {
  it('renders JSON with --json', () => {
    expect(render({ a: 1 }, true)).toContain('"a": 1')
  })
  it('renders plain strings as-is', () => {
    expect(render('hello', false)).toBe('hello')
  })
})

describe('handoff v1', () => {
  it('honestly reports unsupported with the interface intact', () => {
    const r = handoffV1('s-1', 'n-2')
    expect(r.supported).toBe(false)
    expect(r.session_id).toBe('s-1')
    expect(r.to_node).toBe('n-2')
    expect(r.reason).toContain('not implemented')
  })
})

describe('help', () => {
  it('documents all commands', () => {
    for (const cmd of ['init', 'agent', 'hub', 'status', 'doctor', 'dashboard', 'install', 'nodes', 'route-explain', 'presence', 'rotate-token', 'handoff', 'verify', 'pair', 'join']) {
      expect(HELP_TEXT).toContain(cmd)
    }
  })
})