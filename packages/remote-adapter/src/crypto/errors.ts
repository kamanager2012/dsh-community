export type RemoteCryptoErrorCode =
  | 'HOST_IDENTITY_MISMATCH'
  | 'PAIRING_TOKEN_INVALID'
  | 'PAIRING_FAILED'
  | 'DEVICE_NOT_TRUSTED'
  | 'DEVICE_REVOKED'
  | 'HANDSHAKE_FAILED'
  | 'HANDSHAKE_STATE_INVALID'
  | 'CIPHERTEXT_INVALID'
  | 'NONCE_EXHAUSTED'
  | 'TRUST_DOMAIN_STALE'
  | 'UNAUTHORIZED_CHANNEL'
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
