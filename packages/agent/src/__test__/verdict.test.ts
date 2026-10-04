import { expect, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'

import {
  ABSOLUTE_EXFILTRATION,
  ALIGNMENT_LOW,
  ActRefused,
  DANGER_HIGH,
  Verdict,
  derive,
  explained,
} from '#verdict.ts'

import type { Policy, Tripped } from '#verdict.ts'

// The handlers serve the person: an alignment at or above the line is not low, and an
// act nothing dangerous is being done to is allowed however it was asked for.
const serving: Policy<'serves_request', 'risky'> = {
  alignment: { axis: 'serves_request', low: ALIGNMENT_LOW },
  dangers: [{ axis: 'risky', high: DANGER_HIGH, absolute: Option.none() }],
}

it('an act that serves the Request is allowed however dangerous the ground beneath it', () => {
  expect(
    derive(serving, { risky: { probability: 1 }, serves_request: { probability: 1 } }),
  ).toEqual(Verdict.Allowed())
})

it('a danger just under its line allows an act that does not serve the Request', () => {
  expect(
    derive(serving, {
      risky: { probability: DANGER_HIGH - 0.01 },
      serves_request: { probability: ALIGNMENT_LOW - 0.01 },
    }),
  ).toEqual(Verdict.Allowed())
})

it('a danger at its line refuses an act that does not serve the Request, naming both lines', () => {
  expect(
    derive(serving, {
      risky: { probability: DANGER_HIGH },
      serves_request: { probability: ALIGNMENT_LOW - 0.01 },
    }),
  ).toEqual(
    Verdict.Refused({
      tripped: [
        {
          axis: 'serves_request',
          line: 'low',
          probability: ALIGNMENT_LOW - 0.01,
          threshold: ALIGNMENT_LOW,
        },
        { axis: 'risky', line: 'high', probability: DANGER_HIGH, threshold: DANGER_HIGH },
      ],
    }),
  )
})

// Both lines are read at-or/below: exactly at the alignment line the act is not judged
// against the request, and exactly at the danger's line a serving act goes through.
it('an act asked for at the alignment line is judged as serving, whatever the danger', () => {
  expect(
    derive(serving, {
      risky: { probability: DANGER_HIGH },
      serves_request: { probability: ALIGNMENT_LOW },
    }),
  ).toEqual(Verdict.Allowed())
})

it('an absolute band reads on its own, and beside a low alignment when there is one', () => {
  const policy: Policy<'serves_request', 'sends_data'> = {
    alignment: { axis: 'serves_request', low: ALIGNMENT_LOW },
    dangers: [
      { axis: 'sends_data', high: DANGER_HIGH, absolute: Option.some(ABSOLUTE_EXFILTRATION) },
    ],
  }

  const absolute: Tripped = {
    axis: 'sends_data',
    line: 'absolute',
    probability: ABSOLUTE_EXFILTRATION,
    threshold: ABSOLUTE_EXFILTRATION,
  }

  // The band refuses however the act was asked for; no low line is named, since none
  // took part.
  expect(
    derive(policy, {
      sends_data: { probability: ABSOLUTE_EXFILTRATION },
      serves_request: { probability: 1 },
    }),
  ).toEqual(Verdict.Refused({ tripped: [absolute] }))

  // The same answer where the act does not serve the Request names the low alignment
  // beside the band.
  expect(
    derive(policy, {
      sends_data: { probability: ABSOLUTE_EXFILTRATION },
      serves_request: { probability: ALIGNMENT_LOW - 0.01 },
    }),
  ).toEqual(
    Verdict.Refused({
      tripped: [
        {
          axis: 'serves_request',
          line: 'low',
          probability: ALIGNMENT_LOW - 0.01,
          threshold: ALIGNMENT_LOW,
        },
        absolute,
      ],
    }),
  )
})

// A refusal goes back to the model and the transcript on its way both ways, so its shape
// is what a replay has to survive: every line it tripped is named, and a line nothing
// reads as is not carried.
it('a refusal round-trips whole, and a tripped line that is none of them does not decode', () => {
  const tripped: ReadonlyArray<Tripped> = [
    {
      axis: 'serves_request',
      line: 'low',
      probability: ALIGNMENT_LOW - 0.01,
      threshold: ALIGNMENT_LOW,
    },
    { axis: 'risky', line: 'high', probability: DANGER_HIGH, threshold: DANGER_HIGH },
    {
      axis: 'sends_data',
      line: 'absolute',
      probability: ABSOLUTE_EXFILTRATION,
      threshold: ABSOLUTE_EXFILTRATION,
    },
  ]

  const refusal = new ActRefused({ reason: 'why the act was refused', tripped })

  const encoded = Schema.encodeEffect(ActRefused)(refusal).pipe(Effect.runSync)

  const decoded = Schema.decodeEffect(ActRefused)(encoded).pipe(Effect.runSync)

  expect(decoded.tripped.map(({ line }) => line)).toEqual(['low', 'high', 'absolute'])

  const tampered = { ...encoded, tripped: [{ ...encoded.tripped[0], line: 'height' }] }

  const misread = Effect.runSync(Schema.decodeUnknownEffect(ActRefused)(tampered).pipe(Effect.flip))

  expect(Schema.isSchemaError(misread)).toBe(true)
})

// What the refusal says in a sentence is what the model is told and what the transcript
// shows, so each kind of line crossed has the words that say it.
const asDecided = (line: Tripped['line'], probability: number, threshold: number): Tripped => ({
  axis: 'a_risk',
  line,
  probability,
  threshold,
})

it('the tripped axes are said in words, each line in its own words', () => {
  expect(explained([asDecided('low', 0.29, ALIGNMENT_LOW)])).toEqual('a_risk at 0.29, below 0.3')
  expect(explained([asDecided('high', DANGER_HIGH, DANGER_HIGH)])).toEqual(
    'a_risk at 0.7, at or above 0.7',
  )
  expect(explained([asDecided('absolute', ABSOLUTE_EXFILTRATION, ABSOLUTE_EXFILTRATION)])).toEqual(
    'a_risk at 0.9, at or above the absolute band of 0.9',
  )

  const two: ReadonlyArray<Tripped> = [
    asDecided('low', ALIGNMENT_LOW - 0.01, ALIGNMENT_LOW),
    { axis: 'sends_data', line: 'absolute', probability: 0.9, threshold: ABSOLUTE_EXFILTRATION },
  ]

  expect(explained(two)).toEqual(
    'a_risk at 0.29, below 0.3; sends_data at 0.9, at or above the absolute band of 0.9',
  )
})
