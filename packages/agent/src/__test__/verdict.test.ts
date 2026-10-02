import { expect, it } from '@effect/vitest'
import { Option } from 'effect'

import { ABSOLUTE_EXFILTRATION, ALIGNMENT_LOW, DANGER_HIGH, Verdict, derive } from '#verdict.ts'

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
