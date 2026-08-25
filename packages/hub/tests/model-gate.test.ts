/**
 * Model declaration gate unit tests：声明式模型门禁的纯函数校验。
 * 通过/拒绝/缺声明三态 + 拒绝文本可解析性。
 */

import { describe, expect, it } from 'vitest'
import { checkModelDeclaration, rejectionText, REQUIRED_MODEL, MODEL_GATED_TOOLS } from '../src/mcp/model-gate.js'

describe('checkModelDeclaration', () => {
  it('allows gpt-5-6-thinking in its canonical form', () => {
    expect(checkModelDeclaration('[model-check] 当前模型是 gpt-5-6-thinking').ok).toBe(true)
  })

  it('allows case/delimiter variants of GPT-5.6 Thinking', () => {
    for (const text of [
      '[model-check] 当前模型是 GPT-5.6 Thinking',
      'chatgpt 当前模型为 gpt-5.6-thinking, 开始执行',
      '我用的是 GPT 5 6 thinking',
      'model: gpt5.6thinking',
    ]) {
      expect(checkModelDeclaration(text).ok, text).toBe(true)
    }
  })

  it('allows GPT-5.6 Sol (case/delimiter variants)', () => {
    for (const text of [
      '[model-check] 当前模型是 gpt-5-6-sol',
      '[model-check] 当前模型是 GPT-5.6 Sol',
      'model: gpt5.6sol',
      '当前模型是 GPT 5 6 Sol，开始执行',
    ]) {
      expect(checkModelDeclaration(text).ok, text).toBe(true)
    }
  })

  it('rejects 5.5-mini declarations with received value', () => {
    const r = checkModelDeclaration('[model-check] 当前模型是 5.5-mini')
    expect(r).toEqual({ ok: false, code: 'model_rejected', received: '5.5-mini' })
  })

  it('rejects 5.5 mini variants', () => {
    for (const text of ['当前模型 5.5 mini', '我用的是 5.5mini', '[model-check] 5.5-mini']) {
      const r = checkModelDeclaration(text)
      expect(r.ok, text).toBe(false)
      expect((r as { code?: string }).code).toBe('model_rejected')
    }
  })

  it('requires a declaration when the message has none', () => {
    expect(checkModelDeclaration('列出所有 DSH 会话')).toEqual({ ok: false, code: 'model_declaration_required' })
    expect(checkModelDeclaration('').ok).toBe(false)
  })

  it('rejection text is parseable JSON with required_model', () => {
    const rejected = checkModelDeclaration('5.5-mini')
    expect(rejected.ok).toBe(false)
    const parsed = JSON.parse(rejectionText(rejected as Extract<typeof rejected, { ok: false }>))
    expect(parsed.code).toBe('model_rejected')
    expect(parsed.required_model).toBe(REQUIRED_MODEL)
    const missing = checkModelDeclaration('普通指令')
    const parsed2 = JSON.parse(rejectionText(missing as Extract<typeof missing, { ok: false }>))
    expect(parsed2.code).toBe('model_declaration_required')
  })

  it('gates exactly the message-injection tools', () => {
    expect(MODEL_GATED_TOOLS.has('sessions_prompt')).toBe(true)
    expect(MODEL_GATED_TOOLS.has('sessions_create')).toBe(true)
    expect(MODEL_GATED_TOOLS.has('sessions_list')).toBe(false)
  })
})