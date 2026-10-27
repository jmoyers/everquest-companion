// The article rule — `shared/mobNames.ts`, the one fold the Maps pins and the Recommended tab share.
//
// Pinned here rather than inside either surface's suite because BOTH read it, and a rule two
// surfaces share is a rule whose test should not belong to one of them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCommonMob } from '../src/shared/mobNames'

test('a leading article is a common spawn, case-insensitively', () => {
  assert.equal(isCommonMob('a bandit'), true)
  assert.equal(isCommonMob('an orc centurion'), true)
  assert.equal(isCommonMob('An orc centurion'), true, 'the wiki capitalizes some articles')
  assert.equal(isCommonMob('A Chokidai Growler'), true)
})

test('the article has to be a whole word at the front — a name that merely starts with A is named', () => {
  assert.equal(isCommonMob('Asaka L`Rei'), false)
  assert.equal(isCommonMob('Anaconda'), false)
  assert.equal(isCommonMob('Arisen Thaumaturgist'), false, '`a`/`an` must be whole words')
  assert.equal(isCommonMob('the ghoul lord'), false, 'lowercase `the` is a classic NAMED spelling')
  assert.equal(isCommonMob('skeleton Lrodd'), false)
  assert.equal(isCommonMob(''), false)
})

test('a proper noun spelled as a bare A-word reads as a common — the rule is the article, stated as such', () => {
  // `A Druid` is the wiki page of a named spawn in some zones, and nothing in the name says so.
  // The fold refuses to guess: this IS the shipped answer, and the header says why.
  assert.equal(isCommonMob('A Druid'), true)
})
