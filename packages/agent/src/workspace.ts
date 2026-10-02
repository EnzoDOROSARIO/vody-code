import { Context } from 'effect'

// Stryker disable StringLiteral: the key only names the reference in a context, and
// nothing else in the package claims a name it could collide with.
export const Workspace: Context.Reference<string> = Context.Reference<string>('agent/Workspace', {
  defaultValue: () => process.cwd(),
})
// Stryker restore StringLiteral
