export type RemoteCryptoErrorCode =
  | 'HOST_IDENTITY_MISMATCH'
  | 'PAIRING_TOKEN_INVALID'
  | 'PAIRING_TOKEN_EXPIRED'
  | 'PAIRING_TOKEN_USED'
  | 'DEVICE_NOT_TRUSTED'
  | 'DEVICE_REVOKED'
  | 'HANDSHAKE_FAILED'
  | 'HANDSHAKE_STATE_INVALID'
  | 'CIPHERTEXT_INVALID'
  | 'STATE_CAPACITY_EXCEEDED'

export class RemoteCryptoError extends Error {
  constructor(
    readonly code: RemoteCryptoErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RemoteCryptoError'
  }
}
