import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_CHAT_AWAITING_COLOR,
  AI_CHAT_ERROR_COLOR,
  AI_CHAT_LOCKED_PLACEHOLDER,
  AI_PROACTIVE_PARKED,
  AI_PROACTIVE_SHIPPED,
  aiChatComposerPlaceholder,
  aiChatPhaseColor,
  aiHelpText,
  slashGhost
} from '../src/shared/aiSlash'

test('slashGhost completes /mo to /model', () => {
  assert.equal(slashGhost('/mo'), '/model')
  assert.equal(slashGhost('/model'), null)
  assert.equal(slashGhost('model'), null)
})

test('help lists commands without em dashes', () => {
  const text = aiHelpText()
  assert.match(text, /\/help/)
  assert.match(text, /\/model/)
  assert.doesNotMatch(text, /\/proactive/)
  assert.doesNotMatch(text, /\u2013|\u2014/)
})

test('proactive is parked this PR', () => {
  assert.equal(AI_PROACTIVE_SHIPPED, false)
  assert.equal(
    AI_PROACTIVE_PARKED,
    'Proactive tips are not in this version. Next pass they will name key drops and named enemies, not a catalog list.'
  )
  assert.doesNotMatch(AI_PROACTIVE_PARKED, /\u2013|\u2014/)
  assert.equal(slashGhost('/pr'), null)
})

test('awaiting reply is amber; the composer names the lock only while locked', () => {
  assert.equal(AI_CHAT_LOCKED_PLACEHOLDER, 'Chat is locked while awaiting reply.')
  assert.doesNotMatch(AI_CHAT_LOCKED_PLACEHOLDER, /\u2013|\u2014/)
  assert.equal(aiChatPhaseColor('awaiting'), AI_CHAT_AWAITING_COLOR)
  assert.equal(AI_CHAT_AWAITING_COLOR, '#e0a94a')
  assert.equal(aiChatPhaseColor('error'), AI_CHAT_ERROR_COLOR)
  assert.equal(aiChatPhaseColor('idle'), null)
  assert.equal(aiChatPhaseColor('sent'), null)
  const idle = 'Ask about an item, spell, or this fight.'
  assert.equal(aiChatComposerPlaceholder(false, idle), idle)
  assert.equal(aiChatComposerPlaceholder(true, idle), AI_CHAT_LOCKED_PLACEHOLDER)
})
