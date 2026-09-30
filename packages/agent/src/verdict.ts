import { Data, Option, Schema } from 'effect'

// The thresholds of every Gate, in one place, so tuning one is a single edit. Each is
// read the way `derive` pins it: an alignment is low strictly below its line, and a
// danger is high, or in its absolute band, at or above its line.

/** Below this, an act is judged not to serve the Request: 0.29 is low, 0.3 is not. */
export const ALIGNMENT_LOW = 0.3

/** At or above this, a danger axis is high: 0.7 is high, 0.69 is not. */
export const DANGER_HIGH = 0.7

/**
 * At or above this, an act likely to change what cannot be put back is refused whatever
 * the alignment: there is no arm yet that asks the person first, and a Judge that has
 * been talked into seeing an act as requested must not be enough on its own.
 */
export const ABSOLUTE_IRREVERSIBLE = 0.95

/**
 * At or above this, an act likely to send data off the machine is refused whatever the
 * alignment. Lower than the band for irreversibility, because the alignment is the answer
 * a model that has been talked into an act is surest of, and data once sent cannot be
 * called back or even counted.
 */
export const ABSOLUTE_EXFILTRATION = 0.9

/** How the answer on one danger axis is read. */
export type Danger<Axis extends string> = {
  readonly axis: Axis
  /** At or above this, the axis is high, and refuses when the alignment is low. */
  readonly high: number
  /** At or above this, the axis refuses whatever the alignment; none for an axis without a band. */
  readonly absolute: Option.Option<number>
}

/**
 * What a Gate's questions mean to the Verdict: which answer is the alignment and where
 * it turns low, and how each other answer is read as a danger. Data rather than code, so
 * a Gate with one danger axis and a Gate with three derive their Verdicts by the same
 * two rules.
 */
export type Policy<Alignment extends string, Axis extends string> = {
  readonly alignment: { readonly axis: Alignment; readonly low: number }
  readonly dangers: ReadonlyArray<Danger<Axis>>
}

/** Which line an axis crossed: an alignment is refused for being below, a danger for being at or above. */
export const Line = Schema.Literals(['low', 'high', 'absolute'])

export type Line = typeof Line.Type

/** One axis that took part in a refusal: what the Judge answered on it, and the line it crossed. */
// Stryker disable next-line ObjectLiteral: a tripped axis is plain JSON already, so
// encoding it for the model hands it over unchanged whatever the struct names; the
// fields are here for the type a refusal has to carry.
export const Tripped = Schema.Struct({
  axis: Schema.String,
  probability: Schema.Finite,
  line: Line,
  threshold: Schema.Finite,
})

export type Tripped = typeof Tripped.Type

/**
 * What a Gate concludes about one act. Two arms today. A third, seeking the person's
 * approval, would be one more member here and one more case wherever a Verdict is
 * matched; nothing that derives one or acts on one assumes there are only two.
 */
export type Verdict = Data.TaggedEnum<{
  Allowed: {}
  Refused: { readonly tripped: ReadonlyArray<Tripped> }
}>

export const Verdict = Data.taggedEnum<Verdict>()

const below = (probability: number, threshold: number): boolean => probability < threshold

const reaches = (probability: number, threshold: number): boolean => probability >= threshold

/**
 * The Verdict on one act, from the Judge's answers. Two rules: an act is refused when
 * its alignment is low and a danger is high, and when a danger is in its absolute band
 * whatever the alignment.
 *
 * A refusal carries every axis that took part: each danger at the line it crossed, and
 * the alignment whenever it was low, since a low alignment is what lets a high danger
 * refuse and is worth knowing beside an absolute one.
 */
export const derive = <Alignment extends string, Axis extends string>(
  policy: Policy<Alignment, Axis>,
  answers: { readonly [Key in Alignment | Axis]: { readonly probability: number } },
): Verdict => {
  const alignment = answers[policy.alignment.axis].probability

  const low = below(alignment, policy.alignment.low)

  const dangers = policy.dangers.flatMap((danger): ReadonlyArray<Tripped> => {
    const { axis, high } = danger

    const { probability } = answers[axis]

    return Option.match(
      Option.filter(danger.absolute, (band) => reaches(probability, band)),
      {
        onSome: (band) => [{ axis, probability, line: 'absolute', threshold: band }],
        onNone: () =>
          low && reaches(probability, high)
            ? [{ axis, probability, line: 'high', threshold: high }]
            : [],
      },
    )
  })

  if (dangers.length === 0) {
    return Verdict.Allowed()
  }

  const aligned: ReadonlyArray<Tripped> = low
    ? [
        {
          axis: policy.alignment.axis,
          probability: alignment,
          line: 'low',
          threshold: policy.alignment.low,
        },
      ]
    : []

  return Verdict.Refused({ tripped: [...aligned, ...dangers] })
}

/**
 * An act the Judge answered on and the Verdict refused. Retrying it is pointless: the
 * same act, asked about again, is the same act.
 *
 * `tripped` is every axis that took part, with the Judge's answer and the line it
 * crossed. `reason` says the same in a sentence, which is what the model is told and
 * what the transcript shows, so a well-judged refusal can be told from a line drawn in
 * the wrong place.
 */
export class ActRefused extends Schema.TaggedError<ActRefused>()('ActRefused', {
  tripped: Schema.Array(Tripped),
  reason: Schema.String,
}) {}

const CROSSED = {
  absolute: 'at or above the absolute band of',
  high: 'at or above',
  low: 'below',
} satisfies { readonly [Crossed in Line]: string }

/** The tripped axes in words: each with the Judge's answer and the line it crossed. */
export const explained = (tripped: ReadonlyArray<Tripped>): string =>
  tripped
    .map(
      ({ axis, line, probability, threshold }) =>
        `${axis} at ${probability}, ${CROSSED[line]} ${threshold}`,
    )
    .join('; ')
