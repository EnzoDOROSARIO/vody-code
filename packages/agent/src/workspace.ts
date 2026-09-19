import { Context } from 'effect'

export const Workspace: Context.Reference<string> = Context.Reference<string>('agent/Workspace', {
  defaultValue: () => process.cwd(),
})
