import { describe, expect, it } from 'vitest'
import { parseAgentArgs } from '../src/agent-cli.js'

describe('agent-cli args', () => {
  it('parses --hub and --quiet', () => {
    const opts = parseAgentArgs(['--hub', 'ws://127.0.0.1:3470', '--quiet'])
    expect(opts.hubUrl).toBe('ws://127.0.0.1:3470')
    expect(opts.logLines).toBe(false)
  })

  it('defaults to verbose', () => {
    const opts = parseAgentArgs([])
    expect(opts.hubUrl).toBeUndefined()
    expect(opts.logLines).toBe(true)
  })

  it('rejects unknown options', () => {
    expect(() => parseAgentArgs(['--nope'])).toThrow(/unknown agent option/)
  })
})