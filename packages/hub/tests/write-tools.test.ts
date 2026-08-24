/**
 * WRITE_TOOLS anti-regression: the single-writer set must cover EVERY tool the
 * hub MCP server can use to mutate hub-local state or issue write directives
 * to nodes. Derived from the actual tool table (danger != read), so a new
 * mutating tool without an entry in WRITE_TOOLS fails this test — which is the
 * point: a follower hub must never execute such a tool locally.
 */

import { describe, expect, it } from 'vitest'
import { DANGER } from '@dsh-helm/protocol'
import { TOOLS, WRITE_TOOLS } from '../src/mcp/tools.js'

describe('WRITE_TOOLS covers every mutating tool', () => {
  it('lists the complete expected write surface', () => {
    expect([...WRITE_TOOLS].sort()).toEqual(
      [
        'code_use_workspace', // routes a write directive (danger=WRITE) to a node
        'sessions_create', // issues node.create_session
        'sessions_resume', // issues node.resume_session (destructive)
        'sessions_prompt', // issues node.prompt (destructive)
        'sessions_cancel', // issues node.cancel (destructive)
        'presence_claim', // mutates hub-local presence registry
        'presence_release', // mutates hub-local presence registry
      ].sort(),
    )
  })

  it('every danger != read tool is in the set (anti-forgetting)', () => {
    const mutating = TOOLS.filter((t) => t.danger !== DANGER.READ)
    expect(mutating.length).toBeGreaterThan(0)
    for (const t of mutating) {
      expect(WRITE_TOOLS.has(t.name), `tool ${t.name} (danger=${t.danger}) must be in WRITE_TOOLS`).toBe(true)
    }
  })

  it('every listed name exists in the tool table (no dead entries)', () => {
    const names = new Set(TOOLS.map((t) => t.name))
    for (const n of WRITE_TOOLS) {
      expect(names.has(n), `WRITE_TOOLS has unknown tool ${n}`).toBe(true)
    }
  })
})