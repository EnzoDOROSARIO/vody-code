export const meta = {
  name: 'review-changes',
  description: 'Review the uncommitted tree, apply what survives scrutiny, drive CRAP to 10',
  whenToUse:
    'Before committing. The pre-commit hook holds a commit until this has run against the current tree.',
  phases: [
    { title: 'Review', detail: 'four independent lenses over everything uncommitted' },
    { title: 'Verify', detail: 'adversarial pass that kills findings it cannot confirm' },
    { title: 'Fix', detail: 'apply the survivors serially, keep the gate green' },
    { title: 'CRAP', detail: 'coverage + crap4ts, every score to 10 or below' },
    { title: 'Record', detail: 'record that this tree was reviewed, so the hook lets it through' },
  ],
}

// This workflow never commits. It is the gate a commit waits behind, so committing
// from inside it would trip its own hook and defeat the point.

const BUN = 'PATH="/Users/enzodorosario/.bun/bin:$PATH"'

const REPO = '/Users/enzodorosario/projects/vody-code'

const CONTEXT = `
## Repo
${REPO} — a Bun + Effect monorepo. Its CLAUDE.md is already in your context; follow it.

## What you are reviewing
Everything not yet committed. Establish it yourself, first, before reading anything else:
    cd ${REPO} && git status --short
    cd ${REPO} && git diff HEAD
Files shown as \`??\` are UNTRACKED — \`git diff\` does not show them, so read those in full
from disk. \`git diff HEAD\` covers staged and unstaged changes to tracked files together.

Review the change, not the whole repo. Existing code is only in scope where the change
touches it or where the change is wrong because of it.

## Running anything
bun is NOT on PATH in this shell. Prefix every bun command:
    cd ${REPO} && ${BUN} bun run check
    cd ${REPO} && ${BUN} bun test
\`bun run check\` is oxlint, then oxfmt --check, then tsc -b.

## Already enforced by tooling — do NOT report it
oxlint (with the vendored anti-slop plugin: no type assertions at all, no \`unknown\`
parameters, no runtime \`typeof\`, no module mocking, required blank-line spacing),
oxfmt, and tsc under strict plus noUncheckedIndexedAccess, exactOptionalPropertyTypes
and noPropertyAccessFromIndexSignature. If it would be caught by \`bun run check\`,
it is not a finding. Report design, correctness, naming, duplication, test quality
and API misuse.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['file', 'severity', 'title', 'detail', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          real: { type: 'boolean' },
          why: { type: 'string' },
        },
        required: ['id', 'real', 'why'],
      },
    },
  },
  required: ['verdicts'],
}

const CRAP_SCHEMA = {
  type: 'object',
  properties: {
    green: { type: 'boolean' },
    before: { type: 'string' },
    after: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['green', 'before', 'after', 'notes'],
}

// The verify phase rules on findings by position, because a title is prose and prose does
// not survive a round trip through a model intact: one trimmed full stop and a finding
// nobody refuted would be dropped as if they had.
const withIds = (findings) => findings.map((finding, id) => ({ id, ...finding }))

const LENSES = [
  {
    key: 'standards',
    prompt: `Review the change against the repo's own documented conventions and against the
Fowler smell baseline (Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive
Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality,
Message Chains, Middle Man, Refused Bequest). CLAUDE.md is in your context — hold the change
to what it actually says, especially on imports, on where tests live, and on comments that
explain WHY in prose rather than restating the code. Judge whether new comments are accurate
and earn their length; a confidently wrong comment is worse than none. A documented repo rule
beats the smell baseline, and smells are judgement calls rather than violations.`,
  },
  {
    key: 'correctness',
    prompt: `Hunt for real defects. Reason about concrete inputs that break the changed code, and
prefer the inputs this code will actually meet over exotic ones. Check boundaries: empty and
absent values, one-element and zero-element collections, indices that can run past an end,
arithmetic that can go negative, wide characters and multi-byte text, and anything that assumes
a shape a library does not guarantee. Where the change consumes a third-party API, verify the
signature against the installed version in node_modules rather than from memory.
Verify each suspicion by running it: write a scratch script in a directory of its own
(\`dir=$(mktemp -d)\`), run it with bun, then DELETE it. It can import from a package by absolute
path, so it does not need to live inside one — and it must not: the four lenses run at the same
time, and a stray file under \`packages/*/src\` fails \`bun run check\` for every other agent.
Leave no scratch file behind. Do not edit source in this phase.`,
  },
  {
    key: 'tests',
    prompt: `Judge the tests. Which behaviours are asserted so weakly that an obvious regression
would still pass? Which branches of the changed code are never exercised? Are exact-string
assertions brittle in ways that will fail for the wrong reason later? Is any test shaped around
the implementation rather than the behaviour, so that a legitimate refactor breaks it? Is any
test asserting something the code cannot actually get wrong? Name the specific cases you would
add, with the input and the expected output. Do not edit any file in this phase.`,
  },
  {
    key: 'simplicity',
    prompt: `Look for what should not exist or should be smaller: speculative generality, an
abstraction with a single caller that earns nothing, duplicated shapes wanting one helper, a
parameter that is always passed the same value, a threaded argument nothing reads, dead
branches, an export nothing outside the module uses, and wrong altitude — a function doing two
jobs, or a helper taking a flag the caller already knew. Be concrete: name what to delete or
merge, and say what is lost if it goes. Do not edit any file in this phase.`,
  },
]

phase('Review')

const reviewed = await pipeline(
  LENSES,
  (lens) =>
    agent(
      `You are reviewing an uncommitted change. Report findings only — do not edit any file.\n${CONTEXT}\n## Your lens: ${lens.key}\n${lens.prompt}\n\nReport only what you would genuinely change. An empty findings list is a good answer when the change is sound. For each finding give the file, the line if you have one, a severity, a one-line title, the detail, and the concrete fix.`,
      { label: `review:${lens.key}`, phase: 'Review', schema: FINDINGS_SCHEMA },
    ),
  (result, lens) => {
    if (!result || !result.findings.length) {
      return { key: lens.key, findings: [], attacked: 0 }
    }

    return agent(
      `You are an adversarial reviewer. Another agent reviewed this uncommitted change through the "${lens.key}" lens and produced the findings below. Your job is to REFUTE them.\n${CONTEXT}\n## Findings to attack\n${JSON.stringify(withIds(result.findings), null, 1)}\n\nRead the real code before ruling on each one. Mark \`real: false\` when a finding is wrong, is already handled elsewhere, describes a deliberate decision the code or its comments justify, is enforced by tooling, is taste with no defect behind it, or would make the code worse. Default to \`real: false\` when unsure — a wrong finding costs more than a missed one, because the next phase will act on whatever survives. Where a finding claims a runtime defect, try to reproduce it with a scratch script in a directory of its own (\`mktemp -d\`) — never under \`packages/*/src\`, where it would fail the lint, typecheck and test gates for every agent running beside you — then run it with bun and DELETE it. Return one verdict per finding, keyed by its \`id\`.`,
      { label: `verify:${lens.key}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((verdict) => {
      const kept = []
      let unjudged = 0

      for (const [id, finding] of result.findings.entries()) {
        const call = verdict && verdict.verdicts.find((v) => v.id === id)

        if (!call) {
          unjudged += 1
          continue
        }

        if (call.real) {
          kept.push(finding)
        }
      }

      // A finding nobody ruled on was lost in transit rather than refuted, and it would
      // otherwise be indistinguishable in the log from one the verifier killed.
      if (unjudged) {
        log(`${lens.key}: ${unjudged} finding(s) came back with no verdict and were dropped`)
      }

      return { key: lens.key, findings: kept, attacked: result.findings.length }
    })
  },
)

const surviving = []

for (const lens of reviewed) {
  if (lens) {
    log(`${lens.key}: ${lens.findings.length} survived of ${lens.attacked}`)

    for (const finding of lens.findings) {
      surviving.push({ lens: lens.key, ...finding })
    }
  }
}

phase('Fix')

const fixed = surviving.length
  ? await agent(
      `Apply the verified review findings below to the working tree. Work SERIALLY — they touch the same few files.\n${CONTEXT}\n## Verified findings\n${JSON.stringify(surviving, null, 1)}\n\nRules:\n- Apply every finding unless applying it would break something. If you skip one, name it and say why.\n- Match the surrounding code's voice: arrow consts with explicit return types, comments that say WHY in prose, no semicolons, single quotes, 2-space indent.\n- Never weaken or delete a test to make something pass. If behaviour legitimately changes, update the expectation and say so.\n- Then run, in order, until all three are clean:\n    cd ${REPO} && ${BUN} bun run format\n    cd ${REPO} && ${BUN} bun run check\n    cd ${REPO} && ${BUN} bun test\n- Leave no scratch files behind.\n\nReturn plain text: what you changed, what you skipped and why, and the final test count.`,
      { label: 'apply-fixes', phase: 'Fix' },
    )
  : 'No findings survived verification; nothing to apply.'

phase('CRAP')

const crap = await agent(
  `Bring every CRAP score in the changed packages to 10 or below, then confirm the repo is green.\n${CONTEXT}\n## What the fix phase did\n${fixed}\n\n## Measuring\nRegenerate coverage first — never report a stale number:\n    cd ${REPO} && ${BUN} bun test --coverage --coverage-reporter=lcov\nthen, for each package the change touches:\n    cd ${REPO} && crap4ts --root . --lcov coverage/lcov.info packages/<name>/src\nCRAP = CC + CC^3 * (1 - coverage)^3, so CRAP is never below CC: a function whose cyclomatic complexity already exceeds 10 cannot reach 10 by being tested better. Only splitting it, or removing branches, moves that floor.\n\n## The rule, as the user stated it\n"reduce CRAP to 10 or below. A single cond or case that answers one question may stay above 10; do not split it into helpers that take booleans the caller already knew. Nested or mixed-duty functions over 10 must split, and an extract must own its inputs."\n\nA flat switch with one arm per case, answering a single question, is therefore EXEMPT from splitting — but drive its coverage as high as it honestly goes, since uncovered arms are what lift the score above the bare CC. A nested or mixed-duty function over 10 must split, and whatever you extract must take the real values it needs rather than a flag the caller already computed.\n\n## Do\n1. Measure, and report the starting table.\n2. For every function over 10, rule split vs exempt under that rule, and say which and why.\n3. Raise coverage with tests that assert real rendered behaviour. Never write a test whose only purpose is to touch a line — if an arm is unreachable, say so and consider removing it instead, but only when you can show no input reaches it.\n4. Re-measure after every change, regenerating coverage each time.\n5. Finish green:\n     cd ${REPO} && ${BUN} bun run format\n     cd ${REPO} && ${BUN} bun run check\n     cd ${REPO} && ${BUN} bun test\n\nReport: \`before\` and \`after\` are the two tables, \`notes\` holds every split and every exemption with its justification plus the new test count, and \`green\` says whether all three commands above finished clean.`,
  { label: 'reduce-crap', phase: 'CRAP', schema: CRAP_SCHEMA },
)

// Asked as data rather than read back out of the prose, so a report that narrates its own
// progress — "keystroke was not green at 14.2, and is green now" — cannot fail a gate it
// passed, and a report that never arrived cannot throw its way past one.
if (!crap || !crap.green) {
  log('CRAP phase did not end GREEN — the tree stays unrecorded, so the commit stays held')

  return { recorded: false, crap, fixed, surviving }
}

phase('Record')

const recorded = await agent(
  `Record that this tree has been reviewed, so the pre-commit hook lets a commit through.\n${CONTEXT}\n## Do\n1. Verify independently first — do not trust the earlier phases:\n     cd ${REPO} && ${BUN} bun run check\n     cd ${REPO} && ${BUN} bun test\n   If either fails, STOP, write nothing, and report the failure.\n2. Confirm nothing stray is left in the tree: \`git status --short\` should show only the change under review — no scratch files.\n3. Write the fingerprint of the tree as it now stands:\n     cd ${REPO} && .claude/hooks/review-fingerprint.sh > .claude/review-state\n   Write it LAST, after every edit. It is a hash of the current uncommitted content, so any later edit retires it and the hook asks for a fresh review — which is the intent.\n4. Print the recorded value and \`git status --short\`.\n\nDo NOT commit. Committing is the user's to do, and this workflow is the gate that commit waits behind.\n\nReturn plain text: the recorded fingerprint, the final test count, and what remains uncommitted.`,
  { label: 'record', phase: 'Record' },
)

return { recorded: true, record: recorded, crap, fixed, surviving }
