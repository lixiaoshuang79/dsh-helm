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
    for (const cmd of ['init', 'agent', 'hub', 'status', 'nodes', 'route-explain', 'presence', 'rotate-token', 'handoff', 'verify']) {
      expect(HELP_TEXT).toContain(cmd)
    }
  })
})