import { Context, Option } from 'effect'

// What the person typed to start the current Turn, exactly as they typed it, and
// nothing else from the conversation: the request is the only input a person
// authored, and a Gate that also saw the model's account of it would be hearing the
// same opinion twice (ADR 0001).
//
// A Reference rather than a service, so a handler reads it with `yield*` and asks for
// nothing in its requirements: the handler types are fixed by the toolkit. The
// default is none, because a handler can run with no Turn around it at all, and
// none is the honest answer there. `answer` provides the value once around the
// whole Turn, continuations included, so the next Turn's request replaces it and
// nothing leaks between Turns.
// Stryker disable StringLiteral: the key only has to differ from every other service's,
// and nothing reads it back, so no test can tell one spelling from another.
export const Request: Context.Reference<Option.Option<string>> = Context.Reference<
  Option.Option<string>
>('agent/Request', { defaultValue: () => Option.none() })
