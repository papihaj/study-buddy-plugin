import { atom, read, update } from 'claude-code'
import type { EngineInterface as Api, Register } from 'claude-code'

import type { FollowUp, Format, Note, Quiz, Verdict } from '../types'
import { checkLink, parseFocus } from './focus'
import { answerOf, flow } from './answer'
import { appendNote, buildNote, toMarkdown } from './notes'
import { isSecretPath, redact } from './redact'

const PANE = 'study-buddy'
const CONTEXT_CHARS = 6000
const PROJECT_CHARS = 2500
const ANSWER_CHARS = 600
const FRESH_MESSAGES = 6
const NOTHING_NEW = 'Nothing new worth asking about yet. Keep building, and a question will come.'

const EMPTY: Quiz = {
  status: 'idle',
  format: 'free',
  question: '',
  choices: [],
  correct: -1,
  selected: -1,
  explanation: '',
  answer: '',
  draft: '',
  lines: [],
  feedback: '',
  lesson: '',
  followUps: [],
  error: '',
  source: '',
  focus: '',
  term: '',
  definition: '',
  next: '',
}

const quiz = atom({ plugin: 'study-buddy', key: 'quiz' } as const, EMPTY, { shape: 'quiz-mvp-6' })
const format = atom({ plugin: 'study-buddy', key: 'format' } as const, 'free', { shape: 'format-1' })
const asked = atom({ plugin: 'study-buddy', key: 'asked' } as const, [], { shape: 'asked-1' })
const showSettings = atom({ plugin: 'study-buddy', key: 'showSettings' } as const, false, { shape: 'show-settings-1' })
const paused = atom({ plugin: 'study-buddy', key: 'paused' } as const, false, { shape: 'paused-1' })
const askedAt = atom({ plugin: 'study-buddy', key: 'askedAt' } as const, 0, { shape: 'asked-at-1' })
const sessionTokens = atom({ plugin: 'study-buddy', key: 'sessionTokens' } as const, 0, { shape: 'session-tokens-1' })

const BUSY = { thinking: 'idle', grading: 'asking', teaching: 'answered', replying: 'taught' } as const
const isBusy = (status: Quiz['status']): status is keyof typeof BUSY => status in BUSY

const VOICE = `Speak to the developer directly as "you" and "your". Never call them "the student", "the developer", "the user" or "they".`

const ASK_SYSTEM = `You are a professor who teaches software engineering well. You are quizzing a developer who just worked through the session below with a coding assistant. You write one review question that makes them retrieve and reason about the ideas behind that work, so they keep it.

How you teach:
- Ask about the main thing the developer built or changed in the code this session: a feature, a fix or a design choice. Never ask about side work around it, such as commits, branches, docs or notes files, running tests or linters, or how the assistant worked.
- Build the question around one key concept behind that work: an idea from systems design, architecture or engineering practice that they should understand while they build, such as debounce, idempotency, a composite index, cache invalidation or a message queue.
- Ask only about the big, central ideas of the session: the concepts a senior engineer would want the developer to still know in a year. Skip small details, syntax, configuration, and trivia (file names, exact code, what the assistant said).
- The teaching move in the message decides what kind of thinking the question asks for. Follow that move, and only that move.
- The question must be answerable from understanding alone, in a sentence or a short paragraph (under ${ANSWER_CHARS} characters), so ask exactly one thing. If an idea needs an essay, ask about one part of it.
- A question answerable by recalling one word is too shallow. Ask them to reason.
- One question, one idea, under 40 words, plain language. Never reveal the answer in the question.
- Pick a concept the developer has not just been asked about, so practice is spread across topics.
- If every big idea in the session was already asked about, or the session has no real engineering idea in it, do not reach for a small one. Reply {"question": ""} instead.

${VOICE}

Reply with JSON only, no prose.`

const MOVES = [
  'Explain why: ask them to explain the reasoning behind a choice made in the session.',
  'Predict: describe a small change or edge case and ask what would happen and why.',
  'Transfer: put the same idea in an unrelated domain and ask how it applies there.',
  'Compare: ask how this approach differs from a close alternative, and when each wins.',
  'Misconception: state a plausible but wrong belief about the idea and ask what is wrong with it.',
  'Teach it: ask them to explain the idea to a junior developer in two sentences.',
]

const CHOICE_RULES = `For multiple choice: four options; the right one is listed first (it is shuffled later). Each wrong option is a misconception a real developer holds, plausible to someone who half understands. All four have similar length, detail, and grammar, so length or tone never gives the answer away. No "all of the above" or "none of the above". The explanation says why the right one is right and what the most tempting wrong one gets wrong, in one or two sentences. "next" names one related idea worth reviewing next, for someone who got it right, in one short sentence.`

const SOURCE_RULE = `Optionally add "source": the one file the concept came from, copied exactly from a "tool ...: <path>" line in the session. Add ":<line>" only if the session itself shows that file with that line number. Leave "source" out if no file fits.`

const FOCUS_RULE = `The developer also wants to grow in these areas. Always ask about an idea from the session, never about a subject the session does not touch. If the session works on one of these areas directly, ask about that. Otherwise, if an idea from the session has a real, useful link to one of these areas, ask a question that carries the idea into that area: how the same idea shows up there, or what changes when it does. For example, a search box's debounce links to data science through batching a stream of events before a model sees them. Add "focus": that area, copied exactly from the list, and "bridge": a short phrase in that area's own words naming the setting the question uses (such as "batching events before a model"). The question itself must use that setting. If there is no honest link, ask as usual and leave "focus" and "bridge" out. Never force a link.`

const TERM_RULE = `Also add "term": that key concept, named in 1 to 4 words as an engineer would name it (such as "debounce" or "event-driven architecture"), and "definition": what it means, in one plain sentence.`

const GRADE_SYSTEM = `You are a kind, exact professor giving feedback on a developer's short answer to a review question.
Open with one verdict word: "Solid.", "Partly." or "Not yet."
Then, in at most two short sentences: name what they got right, and name the specific gap or misconception (not a vague "add more detail").
If the answer is not Solid, end with the key idea in one plain sentence. If it is Solid, end instead with one related idea worth reviewing next, in one sentence that starts with "Next:".
Do not ask them anything: they cannot reply.
${VOICE}
At most 60 words in all. Plain text, no headings, no lists.`

const LESSON_SYSTEM = `You are a kind, exact professor. A developer just missed part of a review question about the project they are building in the session below, and asked you to go deeper. You write a short micro-lesson on exactly the gap their answer shows, so they get it right next time.
First, the core idea in plain words: what is true, and why.
Then, for each specific technical term the lesson relies on (such as TTL or a race condition), at most three, one line on its own: "<term>: what it means, in a few plain words. In your project: why it matters here, naming the part of the session it touches."
Then one concrete example that makes it click. Use a tiny code snippet only if it truly helps, at most 5 lines, on its own lines with no fences.
End with the one thing to remember, in one plain sentence that starts with "Remember:".
Do not repeat the question or the feedback. Do not end with a question.
${VOICE}
At most 180 words in all. Plain text, no headings, no bullets, no markdown.`

const FOLLOW_SYSTEM = `You are a kind, exact professor. A developer is going deeper on a review question about the project they are building in the session below, and asks you a follow-up. Answer exactly what they asked, in plain words.
If you use a technical term they may not know, say what it means in a few words. Tie the answer to their project when that helps, naming the part of the session it touches.
If the follow-up has nothing to do with the topic or the project, answer in one sentence and steer back.
Do not end with a question.
${VOICE}
At most 100 words. Plain text, no headings, no bullets, no markdown.`

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

type Digest = { text: string; paths: Set<string>; said: string; count: number }

async function digest($: Api): Promise<Digest> {
  const rows = await $.session.messages()
  const cwd = await $.session.cwd()
  const relative = (p: string) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p)
  const lines: string[] = []
  const paths = new Set<string>()
  const said: string[] = []
  for (const m of rows.slice(-40)) {
    if (m.text.trim() !== '') lines.push(`${m.role}: ${clip(redact(m.text.trim()), 600)}`)
    said.push(m.text.split(cwd + '/').join(''))
    for (const t of m.toolUses) {
      const secret = t.input.file_path ?? t.input.path
      if (typeof secret === 'string' && isSecretPath(secret)) continue
      const file = t.input.file_path ?? t.input.notebook_path
      if (typeof file === 'string') paths.add(relative(file))
      const target = typeof file === 'string' ? relative(file) : (t.input.command ?? t.input.pattern ?? '')
      lines.push(`tool ${t.tool}: ${clip(redact(String(target)), 120)}`)
      if (typeof t.text === 'string') said.push(t.text.split(cwd + '/').join(''))
    }
  }
  const text = lines.join('\n')
  return { text: text.slice(-CONTEXT_CHARS), paths, said: said.join('\n'), count: rows.length }
}

function checkSource(given: unknown, { paths, said }: Digest): string {
  const [, path = '', line] = str(given).trim().match(/^(.+?)(?::(\d+))?$/) ?? []
  if (!paths.has(path)) return ''
  if (line === undefined) return path
  const cited = `${path}:${line}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[\\s\`'"(])${cited}(?!\\d)`, 'm').test(said) ? `${path}:${line}` : path
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  } catch {
    return undefined
  }
}

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

type Today = { day: string; tokens: number }

const tokensToday = async ($: Api): Promise<number> => {
  const saved = (await $.store.get('tokensToday')) as Today | undefined
  return saved?.day === dayKey(new Date()) ? saved.tokens : 0
}

async function haiku($: Api, system: string, prompt: string, maxTokens: number): Promise<string | undefined> {
  try {
    const r = await $.model.complete({ model: 'haiku', system, prompt, maxTokens, effort: 'low', timeoutMs: 30000 })
    const n = r.usage.input_tokens + r.usage.output_tokens
    await update($, sessionTokens, t => t + n)
    await $.store.set('tokensToday', { day: dayKey(new Date()), tokens: (await tokensToday($)) + n } satisfies Today)
    return r.isAnswered ? r.text.trim() : undefined
  } catch {
    return undefined
  }
}

const notesDir = async ($: Api) => `${await $.session.cwd()}/study-buddy-notes`

async function saveNote($: Api, q: Quiz) {
  try {
    const dir = await notesDir($)
    let notes: Note[] = []
    try {
      notes = JSON.parse(await $.fs.read(`${dir}/answers.json`)) as Note[]
    } catch {}
    notes = appendNote(notes, buildNote(q, dayKey(new Date())))
    await $.fs.write(`${dir}/answers.json`, JSON.stringify(notes))
    await $.fs.write(`${dir}/notes.md`, toMarkdown(notes))
  } catch {}
}

const savedFocus = async ($: Api): Promise<string[]> => {
  const saved = await $.store.get('focus')
  return Array.isArray(saved) ? saved.filter((t): t is string => typeof t === 'string') : []
}

const openPane = ($: Api, focus?: true) => $.ui.open({ id: PANE, title: 'Study Buddy', focus })

const togglePause = async ($: Api) => $.store.set('paused', await update($, paused, p => !p))

const setFormat = async ($: Api, fn: (f: Format) => Format) => $.store.set('format', await update($, format, fn))

async function askQuestion($: Api, isAsked?: true) {
  if (isBusy((await read($, quiz)).status)) return
  const limit = await $.store.get('dailyLimit')
  if (typeof limit === 'number' && (await tokensToday($)) >= limit) {
    await update($, quiz, (): Quiz => ({ ...EMPTY, status: 'error', error: `You reached today's limit of ${limit.toLocaleString('en-US')} tokens. Run /buddy limit off to remove it.` }))
    return
  }
  const session = await digest($)
  if (session.text.length < 200) {
    await update($, quiz, (): Quiz => ({ ...EMPTY, status: 'error', error: 'Not enough session to ask about yet. A question comes once Claude has replied.' }))
    return
  }
  const fmt: Format = await read($, format)
  await update($, quiz, (): Quiz => ({ ...EMPTY, status: 'thinking', format: fmt }))

  const previous: string[] = await read($, asked)
  const topics = await savedFocus($)
  const focusField = topics.length > 0 ? ', "focus": "...", "bridge": "..."' : ''
  const shape =
    fmt === 'choice'
      ? `${CHOICE_RULES}\n${SOURCE_RULE}\n${TERM_RULE}\nReply as {"question": "...", "choices": ["right", "wrong", "wrong", "wrong"], "explanation": "...", "next": "...", "source": "...", "term": "...", "definition": "..."${focusField}}`
      : `${SOURCE_RULE}\n${TERM_RULE}\nReply as {"question": "...", "source": "...", "term": "...", "definition": "..."${focusField}}`
  const focus = topics.length > 0 ? `Areas the developer wants to grow in:\n${topics.join('\n')}\n${FOCUS_RULE}\n\n` : ''
  const prompt = `Recent session:\n<session>\n${session.text}\n</session>\n\nAlready asked (pick a different concept or angle):\n${previous.slice(-10).join('\n') || '(none)'}\n\nTeaching move for this question: ${MOVES[previous.length % MOVES.length]}\n\n${focus}${shape}`

  const reply = await haiku($, ASK_SYSTEM, prompt, 400)
  const data = reply === undefined ? undefined : parseJson(reply)
  const question = str(data?.question)
  await update($, askedAt, () => session.count)
  if (data !== undefined && question === '') {
    await update($, quiz, (q): Quiz => ({ ...q, status: 'idle', error: NOTHING_NEW }))
    return
  }
  if (question === '') {
    await update($, quiz, (q): Quiz => ({ ...q, status: 'error', error: 'Could not make a question this time.' }))
    return
  }
  const given = Array.isArray(data?.choices) ? data.choices.map(String).slice(0, 4) : []
  const isChoice = fmt === 'choice' && given.length >= 2
  const order = given.map((_, i) => i).sort(() => Math.random() - 0.5)
  await update($, asked, list => [...list, question].slice(-30))
  await update($, quiz, (q): Quiz => ({
    ...q,
    status: 'asking',
    format: isChoice ? 'choice' : 'free',
    question,
    choices: isChoice ? order.map(i => given[i] ?? '') : [],
    correct: isChoice ? order.indexOf(0) : -1,
    explanation: str(data?.explanation),
    source: checkSource(data?.source, session),
    focus: checkLink(data?.focus, data?.bridge, question, topics),
    term: str(data?.term).trim(),
    definition: str(data?.definition).trim(),
    next: str(data?.next).trim(),
  }))
  void openPane($, isAsked)
}

const verdictOf = (feedback: string): Verdict | undefined => {
  const word = feedback.toLowerCase()
  return word.startsWith('solid') ? 'solid' : word.startsWith('partly') ? 'partly' : word.startsWith('not yet') ? 'notYet' : undefined
}

async function gradeFree($: Api, answer: string) {
  const q: Quiz = await read($, quiz)
  if (q.status !== 'asking' || answer.trim() === '') return
  await update($, quiz, (cur): Quiz => ({ ...cur, status: 'grading', answer }))
  const feedback = await haiku($, GRADE_SYSTEM, `Question: ${q.question}\n\nAnswer: ${answer}`, 300)
  const done = await update($, quiz, (cur): Quiz => ({
    ...cur,
    status: 'answered',
    feedback: feedback ?? 'Could not grade this one, but thanks for answering.',
    verdict: feedback === undefined ? undefined : verdictOf(feedback),
  }))
  await saveNote($, done)
}

async function submitChoice($: Api) {
  let changed = false
  const done = await update($, quiz, (cur): Quiz => {
    if (cur.status !== 'asking' || cur.selected < 0) return cur
    changed = true
    const isRight = cur.selected === cur.correct
    const right = cur.choices[cur.correct] ?? ''
    return {
      ...cur,
      status: 'answered',
      verdict: isRight ? 'solid' : 'notYet',
      answer: cur.choices[cur.selected] ?? '',
      feedback: `${isRight ? 'Solid.' : `Not yet. The answer is: ${/[.!?]$/.test(right) ? right : `${right}.`}`} ${cur.explanation}${isRight && cur.next !== '' ? ` Next: ${cur.next}` : ''}`.trim(),
    }
  })
  if (changed) await saveNote($, done)
}

const isMiss = (q: Quiz) => q.verdict === 'partly' || q.verdict === 'notYet'

const projectOf = async ($: Api) => `Recent session:\n<session>\n${(await digest($)).text.slice(-PROJECT_CHARS)}\n</session>\n\n`

async function askFollowUp($: Api, ask: string) {
  const q: Quiz = await read($, quiz)
  if (q.status !== 'taught' || q.lesson === '' || ask.trim() === '') return
  await update($, quiz, (cur): Quiz => ({ ...cur, status: 'replying', lines: [], draft: '', error: '' }))
  const earlier = q.followUps.slice(-3).map(f => `They asked: ${f.ask}\nYou said: ${f.reply}`).join('\n\n')
  const prompt = `${await projectOf($)}Question: ${q.question}\n\nTheir answer: ${q.answer}\n\nFeedback they got: ${q.feedback}\n\nLesson you gave: ${q.lesson}\n\n${earlier === '' ? '' : `${earlier}\n\n`}Follow-up: ${ask}`
  const reply = await haiku($, FOLLOW_SYSTEM, prompt, 300)
  await update($, quiz, (cur): Quiz => ({
    ...cur,
    status: 'taught',
    followUps: [...cur.followUps, { ask, reply: reply ?? 'Could not answer that one. Try asking again.' } satisfies FollowUp],
  }))
}

async function goDeeper($: Api) {
  const q: Quiz = await read($, quiz)
  if (q.status !== 'answered' || !isMiss(q)) return
  await update($, quiz, (cur): Quiz => ({ ...cur, status: 'teaching', lesson: '', error: '' }))
  const right = q.format === 'choice' ? `\n\nRight answer: ${q.choices[q.correct] ?? ''}` : ''
  const project = await projectOf($)
  const lesson = await haiku($, LESSON_SYSTEM, `${project}Question: ${q.question}\n\nTheir answer: ${q.answer}${right}\n\nFeedback they got: ${q.feedback}`, 500)
  await update($, quiz, (cur): Quiz => ({
    ...cur,
    status: 'taught',
    lesson: lesson ?? '',
    followUps: [],
    lines: [],
    draft: '',
    error: lesson === undefined ? 'Could not write a lesson this time.' : '',
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'buddy',
      description: 'Open Study Buddy. Args: now | focus <areas> | notes | limit <tokens>|off | settings | free | choice',
    })
    const wasPaused = (await $.store.get('paused')) === true
    await update($, paused, () => wasPaused)
    const saved = await $.store.get('format')
    if (saved === 'free' || saved === 'choice') await update($, format, () => saved)
    await update($, quiz, (q): Quiz => (isBusy(q.status) ? { ...q, status: BUSY[q.status] } : q))
    void openPane($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const { status } = await read($, quiz)
    if (e.agentId === undefined && status !== 'asking' && !isBusy(status) && !(await read($, paused))) {
      $.clock.after(0, async () => {
        const fresh = (await $.session.messages()).length - (await read($, askedAt))
        if (fresh < 0 || fresh >= FRESH_MESSAGES) void askQuestion($)
      })
    }
    return next(e)
  })

  on('command.run', { command: 'buddy' }, async ($, e) => {
    const [word = ''] = e.args.trim().split(/\s+/)
    const rest = e.args.trim().slice(word.length).trim()
    await openPane($)
    if (word === 'free' || word === 'choice') {
      await setFormat($, () => word)
      return { text: `Study Buddy format: ${word === 'free' ? 'free text' : 'multiple choice'}.` }
    }
    if (word === 'limit') {
      const n = Number(rest.replace(/,/g, ''))
      if (rest === 'off') await $.store.delete('dailyLimit')
      else if (Number.isInteger(n) && n > 0) await $.store.set('dailyLimit', n)
      else if (rest !== '') return { text: 'Usage: /buddy limit <tokens per day> or /buddy limit off' }
      const limit = await $.store.get('dailyLimit')
      return { text: typeof limit === 'number' ? `Daily limit: ${limit.toLocaleString('en-US')} tokens.` : 'No limit. Study Buddy never stops you.' }
    }
    if (word === 'settings') {
      await update($, showSettings, () => true)
      return { text: 'Study Buddy settings opened in the pane.' }
    }
    if (word === 'notes') return { text: `Your notes are in ${await notesDir($)}/notes.md.` }
    if (word === 'now') {
      void askQuestion($, true)
      return { text: 'Making a question.' }
    }
    if (word === 'focus') {
      if (rest === 'clear') await $.store.delete('focus')
      else if (rest !== '') await $.store.set('focus', parseFocus(rest))
      const topics = await savedFocus($)
      return {
        text: topics.length === 0 ? 'No focus areas. Add some with /buddy focus <area>, <area>.' : `Focus areas: ${topics.join(', ')}.`,
      }
    }
    return { text: 'Study Buddy opened. Run /buddy settings to see token use.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const q: Quiz = await read($, quiz)
    const fmt: Format = await read($, format)
    const isSettings: boolean = await read($, showSettings)
    const isPaused: boolean = await read($, paused)
    const n = (x: number) => x.toLocaleString('en-US')
    const busy = isBusy(q.status)
    const asking = q.status === 'asking'
    const typing = asking && q.format === 'free' && Input !== undefined
    const following = q.status === 'taught' && q.lesson !== '' && Input !== undefined
    const typed = (key: string, placeholder: string, label: string, send: (text: string) => void) =>
      Input !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{label}</Text>
          <Box borderStyle="round" borderColor="claude" paddingX={1} flexDirection="column">
            {q.lines.map((line, i) => (
              <Text key={`line-${i}`}>{line}</Text>
            ))}
            <Input
              key={key}
              placeholder={placeholder}
              rows={1}
              autoFocus
              submitLabel=""
              value={q.draft}
              onInput={(value: string) =>
                void update($, quiz, (cur): Quiz => {
                  const left = Math.max(0, ANSWER_CHARS - answerOf(cur, '').length)
                  return { ...cur, ...flow(cur.lines, value.slice(0, left), room) }
                })
              }
              onSubmit={(value: string) => send(answerOf(q, value))}
            />
          </Box>
          {answerOf(q).length >= ANSWER_CHARS && <Text dimColor>That is as long as it can be.</Text>}
        </Box>
      )
    const width = Math.max(0, e.props.bodyColumns - 4)
    const rule = <Text dimColor>{'─'.repeat(width)}</Text>
    const room = Math.max(10, width - 6)
    const fill = e.props.placement === 'dock' ? e.props.scroll.bodyRows : undefined

    return (
      <Box flexDirection="column" paddingX={2} paddingY={1} width={e.props.bodyColumns} minHeight={fill}>
        <Box flexDirection="column" marginBottom={1} width={width}>
          <Box justifyContent="space-between">
            <Text bold color="claude">Study Buddy</Text>
            {isSettings && <Text dimColor>settings</Text>}
          </Box>
          {rule}
        </Box>
        {isSettings ? (
          <Box flexDirection="column">
            <Text bold>Tokens used</Text>
            <Text>Today: {n(await tokensToday($))}</Text>
            <Text>This session: {n(await read($, sessionTokens))}</Text>
          </Box>
        ) : q.status === 'idle' || q.status === 'thinking' || q.status === 'error' ? (
          <Text dimColor>
            {q.status === 'idle' ? (isPaused ? 'Questions are paused. Press Resume when you want them again.' : q.error || 'A question will show up here while Claude works.') : q.status === 'thinking' ? 'Thinking of a question…' : q.error}
          </Text>
        ) : (
          <Box flexDirection="column">
            <Text bold>{q.question}</Text>
            {q.source !== '' && <Text dimColor>From: {q.source}</Text>}
            {q.focus !== '' && <Text dimColor>Linked to: {q.focus}</Text>}
            {asking && q.format === 'choice' && (
              <Box flexDirection="column" marginTop={1}>
                {q.choices.map((c, i) => (
                  <Button key={`choice-${i}`} hotkey={String(i + 1)} plain onPress={() => void update($, quiz, (cur): Quiz => ({ ...cur, selected: i }))}>
                    {q.selected === i ? <Text color="claude" bold>(•) {c}</Text> : <Text>( ) {c}</Text>}
                  </Button>
                ))}
              </Box>
            )}
            {asking && q.format === 'free' && Input === undefined && <Text dimColor>Free-text answers need the terminal or desktop app.</Text>}
            {typing && typed(`answer-${q.question}`, 'Type your answer', 'Your answer', text => void gradeFree($, text))}
            {(q.status === 'answered' || q.status === 'teaching' || q.status === 'taught' || q.status === 'replying') && (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>
                  {q.format === 'free' ? 'You said' : 'You picked'}: {q.answer}
                </Text>
                <Text>{q.feedback}</Text>
                {q.term !== '' && (
                  <Box marginTop={1}>
                    <Text>
                      <Text bold color="claude">{q.term}</Text>
                      {q.definition !== '' && `: ${q.definition}`}
                    </Text>
                  </Box>
                )}
              </Box>
            )}
            {(q.status === 'taught' || q.status === 'replying') && (
              <Box marginTop={1}>
                <Text dimColor={q.lesson === ''}>{q.lesson || q.error}</Text>
              </Box>
            )}
            {q.followUps.map((f, i) => (
              <Box key={`follow-${i}`} flexDirection="column" marginTop={1}>
                <Text dimColor>You asked: {f.ask}</Text>
                <Text>{f.reply}</Text>
              </Box>
            ))}
            {(q.status === 'grading' || q.status === 'teaching' || q.status === 'replying') && (
              <Box marginTop={1}>
                <Text dimColor>{q.status === 'grading' ? 'Checking your answer…' : q.status === 'teaching' ? 'Writing a short lesson…' : 'Thinking about your question…'}</Text>
              </Box>
            )}
            {following && typed(`follow-${q.followUps.length}`, 'Ask a follow-up question', 'Still unsure? Ask a follow-up', text => void askFollowUp($, text))}
          </Box>
        )}
        {!isSettings && !busy && (
          <Box marginTop={1} gap={2}>
            {(q.status === 'idle' || q.status === 'error') && (
              <Button key="now" hotkey="n" variant="primary" onPress={() => void askQuestion($, true)}>
                {q.status === 'idle' ? 'Ask me now' : 'Try again'}
              </Button>
            )}
            {typing && (
              <Button key="send" variant="primary" onPress={() => void gradeFree($, answerOf(q))}>
                Submit
              </Button>
            )}
            {asking && q.format === 'choice' && (
              <Button key="submit" hotkey="a" variant="primary" onPress={() => void submitChoice($)}>
                Submit <Text dimColor>a</Text>
              </Button>
            )}
            {asking && (
              <Button key="skip" hotkey="s" onPress={() => void update($, quiz, (cur): Quiz => ({ ...cur, status: 'idle' }))}>
                Skip <Text dimColor>s</Text>
              </Button>
            )}
            {following && (
              <Button key="ask" variant="primary" onPress={() => void askFollowUp($, answerOf(q))}>
                Ask
              </Button>
            )}
            {(q.status === 'answered' || q.status === 'taught') && (
              <Button key="next" hotkey="n" variant={following ? undefined : 'primary'} onPress={() => void askQuestion($, true)}>
                Next question
              </Button>
            )}
            {q.status === 'answered' && isMiss(q) && (
              <Button key="deeper" hotkey="d" onPress={() => void goDeeper($)}>
                Go deeper <Text dimColor>d</Text>
              </Button>
            )}
          </Box>
        )}
        <Box flexGrow={1} />
        <Box flexDirection="column" marginTop={1}>
          {rule}
          {(isSettings || !busy) && (
            <Box flexDirection="column">
              <Button key="format" hotkey="f" plain onPress={() => void setFormat($, f => (f === 'free' ? 'choice' : 'free'))}>
                Format <Text color="claude">{fmt === 'free' ? 'free text' : 'multiple choice'}</Text>
              </Button>
              <Button key="pause" hotkey="p" plain onPress={() => void togglePause($)}>
                {isPaused ? <Text>Questions <Text color="claude">paused</Text>, resume</Text> : 'Pause questions'}
              </Button>
              {isSettings ? (
                <Button key="back" hotkey="b" variant="primary" onPress={() => void update($, showSettings, () => false)}>
                  Back to the questions
                </Button>
              ) : (
                <Button key="settings" hotkey="g" plain onPress={() => void update($, showSettings, () => true)}>
                  Settings
                </Button>
              )}
            </Box>
          )}
          {!e.props.isFocused && <Text dimColor>ctrl+x tab to answer here</Text>}
        </Box>
      </Box>
    )
  })
}
