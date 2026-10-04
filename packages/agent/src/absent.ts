import { Predicate } from 'effect'

import type { PlatformError } from 'effect'

/**
 * Whether a platform failure is the file system saying the file is not there: the one
 * reason two readers of the workspace — its instructions and its Skills — treat as an
 * absence rather than a failure.
 */
export const absent = (error: PlatformError.PlatformError): boolean =>
  Predicate.isTagged(error.reason, 'NotFound')
