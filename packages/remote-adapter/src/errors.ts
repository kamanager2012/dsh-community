export type RemoteErrorCode =
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'EPOCH_STALE'
  | 'EPOCH_MISMATCH'
  | 'REQUEST_REPLAY'
  | 'DEVICE_UNKNOWN'
  | 'DEVICE_REVOKED'
  | 'CAPABILITY_DENIED'
  | 'IDEMPOTENCY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ALREADY_RESOLVED'
  | 'INVALID_REQUEST'

export class RemoteProtocolError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RemoteProtocolError'
  }
}
