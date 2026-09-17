import { expect, test } from 'bun:test'
import { renderToString } from 'ink'

import { App } from './app.tsx'

test('App greets the world', () => {
  expect(renderToString(<App />)).toBe('Hello World!')
})
