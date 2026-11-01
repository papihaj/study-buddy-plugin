import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'study-buddy',
  component: 'Pane',
  requestId: 'study-buddy',
  props: {
    title: 'Study Buddy',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the idle pane says a question is coming', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /A question will show up here/ })).toBeDefined()
    await ui.unmount()
  }
})

const TYPED = { wait: false, origin: { kind: 'composer' as const } }

const REPLY = JSON.stringify({
  question: 'What happens to writes when you add an index?',
  choices: ['Writes slow down because every index must be updated', 'Reads slow down because the table gets locked', 'Nothing changes at all', 'Old rows are dropped'],
  explanation: 'Each insert updates every index.',
  next: 'Covering indexes.',
  term: 'index',
  definition: 'A lookup structure kept beside a table.',
})

test('picking the right choice grades it Solid', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Added a composite index on orders. '.repeat(10), toolUses: [] }] }))
  on('session.cwd', () => ({ value: '/p' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('model.complete', () => ({ value: { text: REPLY, isAnswered: true, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))

  await $.command.run({ command: 'buddy', args: 'choice', ...TYPED, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'now' })
  expect(await ui.find({ type: 'Button', key: 'speak' })).toBeUndefined()
  for (let i = 0; i < 4; i++) {
    await ui.press({ key: `choice-${i}` })
    if (await ui.find({ type: 'Text', text: /^\(•\) Writes slow down/ })) break
  }
  await ui.press({ key: 'submit' })
  expect(await ui.find({ type: 'Text', text: /^Solid\..*Next: Covering indexes\.$/ })).toBeDefined()
  await ui.unmount()
})

test('after a miss, go deeper explains terms and takes a follow-up question', async ($, on) => {
  const replies = [REPLY, 'TTL: how long a cached value stays valid. In your project: it keeps orders fresh. Remember: expire what changes.', 'Shorter TTLs mean fresher data but more database reads.']
  const prompts: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Added a composite index on orders. '.repeat(10), toolUses: [] }] }))
  on('session.cwd', () => ({ value: '/p' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)
    return { value: { text: replies.shift() ?? '', isAnswered: true, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })

  await $.command.run({ command: 'buddy', args: 'choice', ...TYPED, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'now' })
  for (let i = 0; i < 4; i++) {
    await ui.press({ key: `choice-${i}` })
    if (await ui.find({ type: 'Text', text: /^\(•\) Reads slow down/ })) break
  }
  await ui.press({ key: 'submit' })
  await ui.press({ key: 'deeper' })
  expect(await ui.find({ type: 'Text', text: /In your project:/ })).toBeDefined()
  expect(prompts[1]).toContain('composite index on orders')
  await ui.input({ key: 'follow-0', text: 'What about a shorter TTL?' })
  await ui.press({ key: 'ask' })
  expect(await ui.find({ type: 'Text', text: /You asked: What about a shorter TTL\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Shorter TTLs mean fresher data/ })).toBeDefined()
  expect(prompts[2]).toContain('Follow-up: What about a shorter TTL?')
  await ui.unmount()
})

test('pause holds questions, and a session with nothing new says so', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'Committed and pushed the branch. '.repeat(10), toolUses: [] }] }))
  on('session.cwd', () => ({ value: '/p' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('model.complete', () => ({ value: { text: '{"question": ""}', isAnswered: true, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'now' })
  expect(await ui.find({ type: 'Text', text: /^Nothing new worth asking about yet/ })).toBeDefined()
  await ui.press({ key: 'pause' })
  expect(await ui.find({ type: 'Text', text: /^Questions are paused/ })).toBeDefined()
  await ui.press({ key: 'pause' })
  expect(await ui.find({ type: 'Text', text: /^Questions are paused/ })).toBeUndefined()
  await ui.unmount()
})
