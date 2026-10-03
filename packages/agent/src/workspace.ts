import { Context } from 'effect'

/**
 * Where the agent is working: the directory commands run in and relative paths resolve
 * against. A required port rather than an ambient reference, so a missing provision is
 * a compile error at composition instead of this process's current directory at
 * runtime, and the composition root is the only place that decides where the agent
 * works.
 */
// Stryker disable StringLiteral: the key only names the service in a context, and
// nothing else in the package claims a name it could collide with.
export class Workspace extends Context.Service<Workspace, string>()('agent/Workspace') {}
// Stryker restore StringLiteral
