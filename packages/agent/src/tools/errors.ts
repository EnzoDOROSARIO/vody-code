import { Schema } from 'effect'

import type { PlatformError } from 'effect'

// Raised wherever the file system refuses, so the tools that touch files share one
// way of saying so. Everything narrower belongs to the tool that raises it.
export class FileSystemRefused extends Schema.TaggedError<FileSystemRefused>()(
  'FileSystemRefused',
  { reason: Schema.String },
) {}

export const refused = (error: PlatformError.PlatformError): FileSystemRefused =>
  new FileSystemRefused({ reason: error.message })
