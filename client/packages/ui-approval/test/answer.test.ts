import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APPROVAL_CHOICES, answerFor } from '../src/answer.ts'
import { translate } from '@tianshu/locale'

/**
 * What the three buttons put on the wire, pinned against how the sidecar reads it
 * (`src/server/approval-routes.ts:16-21`):
 *
 *   const decision = data.decision ?? 'approve'
 *   manager.answerIntervention(id, requestId, decision, data.editedInput, data.remember === true)
 *
 * The default is **approve**, so any payload that forgets `decision` approves the tool call.
 * A denial that silently loses its field would not show up as an error — it would show up as
 * the agent doing the thing the user just refused. Nothing here costs an upstream call; the
 * live half (the server accepting it and the mode actually changing) is still task #27.
 */

test('一次放行 approves without remembering', () => {
  assert.deepEqual(answerFor('once'), { decision: 'approve' })
  assert.equal('remember' in answerFor('once'), false, 'a falsey remember must not be sent at all')
})

test('始终允许 is the only choice that carries remember:true', () => {
  assert.deepEqual(answerFor('always'), { decision: 'approve', remember: true })
  for (const other of ['once', 'deny'] as const) {
    assert.notEqual(answerFor(other).remember, true, `${other} must not remember`)
  }
})

test('拒绝 is explicit — a missing decision would read as approval server-side', () => {
  const body = answerFor('deny')
  assert.equal(body.decision, 'deny')
  for (const choice of ['once', 'always', 'deny'] as const) {
    assert.equal(typeof answerFor(choice).decision, 'string', `${choice} must set decision explicitly`)
  }
})

test('the three answers are pairwise distinct', () => {
  const seen = APPROVAL_CHOICES.map(({ choice }) => JSON.stringify(answerFor(choice)))
  assert.equal(new Set(seen).size, 3, `collided payloads: ${seen.join(' / ')}`)
})

test('render order and labels: primary first, deny last, keys resolve in both languages', () => {
  assert.deepEqual(APPROVAL_CHOICES.map((c) => c.choice), ['once', 'always', 'deny'])
  const keys = APPROVAL_CHOICES.map((c) => c.labelKey)
  assert.equal(new Set(keys).size, 3)
  for (const locale of ['zh', 'en'] as const) {
    const labels = keys.map((k) => translate(locale, k))
    for (const label of labels) {
      assert.notEqual(label, undefined)
      assert.doesNotMatch(label, /app\.|approval\./, `untranslated key leaked for ${locale}: ${label}`)
    }
    assert.equal(new Set(labels).size, 3, `${locale} labels must differ`)
  }
})
