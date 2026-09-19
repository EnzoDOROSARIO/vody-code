import { expect, test } from 'bun:test'
import { renderToString } from 'ink'

import { App, Prompt, Transcript } from './app.tsx'

const never: () => Promise<string> = () => new Promise(() => {})

test('the transcript renders each line above the prompt', () => {
  expect(renderToString(<Transcript lines={['> say hi', '$ echo hi', 'hi']} />)).toBe(
    '> say hi\n$ echo hi\nhi',
  )
})

test('the prompt shows what has been typed so far', () => {
  expect(renderToString(<Prompt busy={false} value="who am I" />)).toBe('> who am I')
})

test('the prompt waits while the agent is working', () => {
  expect(renderToString(<Prompt busy value="" />)).toBe('…')
})

test('the app starts with an empty transcript and an empty prompt', () => {
  expect(renderToString(<App ask={never} />)).toBe('>')
})
