export type Format = 'free' | 'choice'

export type Verdict = 'solid' | 'partly' | 'notYet'

export type FollowUp = { ask: string; reply: string }

export type Quiz = {
  status: 'idle' | 'thinking' | 'asking' | 'grading' | 'answered' | 'teaching' | 'taught' | 'replying' | 'error'
  format: Format
  question: string
  choices: string[]
  correct: number
  selected: number
  explanation: string
  answer: string
  draft: string
  lines: string[]
  feedback: string
  verdict?: Verdict
  lesson: string
  followUps: FollowUp[]
  error: string
  source: string
  focus: string
  term: string
  definition: string
  next: string
}

export type Note = {
  day: string
  question: string
  term: string
  definition: string
  answer: string
  verdict: Verdict | 'ungraded'
  feedback: string
  source?: string
  right?: string
}

declare module 'claude-code' {
  interface PluginState {
    'study-buddy': {
      quiz: Shaped<Quiz>
      format: Shaped<Format>
      asked: Shaped<string[]>
      showSettings: Shaped<boolean>
      sessionTokens: Shaped<number>
      paused: Shaped<boolean>
      askedAt: Shaped<number>
    }
  }
}
