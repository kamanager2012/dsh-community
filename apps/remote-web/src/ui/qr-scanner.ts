interface BarcodeDetectorInstance {
  detect(source: ImageBitmapSource): Promise<Array<{ readonly rawValue?: string }>>
}

interface BarcodeDetectorCtor {
  new (options?: { readonly formats?: readonly string[] }): BarcodeDetectorInstance
}

export function isBarcodeDetectorSupported(): boolean {
  const ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  return typeof ctor === 'function'
}

export async function decodeQrFromImageFile(file: Blob): Promise<string> {
  const ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (typeof ctor !== 'function') {
    throw new Error(
      'Image QR decoding requires Chromium/Android BarcodeDetector support. Paste the dsh-remote://pair link or #pair URL directly on iOS Safari.',
    )
  }
  const detector = new ctor({ formats: ['qr_code'] })
  const bitmap = await createImageBitmap(file)
  try {
    const codes = await detector.detect(bitmap)
    const raw = codes.find((c) => typeof c.rawValue === 'string' && c.rawValue.trim().length > 0)?.rawValue
    if (!raw) {
      throw new Error('No QR code detected in the selected image')
    }
    return raw.trim()
  } finally {
    if (typeof bitmap.close === 'function') {
      bitmap.close()
    }
  }
}

export interface CameraQrScannerSession {
  stop(): void
}

export async function startCameraQrScanner(options: {
  readonly videoElement: HTMLVideoElement
  readonly onDetected: (rawPayload: string) => void
  readonly onError: (error: Error) => void
}): Promise<CameraQrScannerSession> {
  const ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (typeof ctor !== 'function') {
    throw new Error(
      'Live browser QR scanning is unavailable on this browser. Point your device Camera app at the pairing QR code or paste the pairing link below.',
    )
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera permission/API unavailable in this context (HTTPS or localhost required)')
  }

  const detector = new ctor({ formats: ['qr_code'] })
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  })

  let stopped = false
  let rafId = 0

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    for (const track of stream.getTracks()) {
      track.stop()
    }
    options.videoElement.srcObject = null
  }

  try {
    options.videoElement.srcObject = stream
    await options.videoElement.play()
  } catch (err) {
    stop()
    throw err instanceof Error ? err : new Error(String(err))
  }

  const scanFrame = (): void => {
    if (stopped) return
    if (options.videoElement.readyState >= 2) {
      void detector
        .detect(options.videoElement)
        .then((codes) => {
          if (stopped) return
          const hit = codes.find((c) => typeof c.rawValue === 'string' && c.rawValue.trim().length > 0)?.rawValue
          if (hit) {
            stop()
            options.onDetected(hit.trim())
            return
          }
          rafId = requestAnimationFrame(scanFrame)
        })
        .catch((err) => {
          if (!stopped) {
            stop()
            options.onError(err instanceof Error ? err : new Error(String(err)))
          }
        })
      return
    }
    rafId = requestAnimationFrame(scanFrame)
  }

  rafId = requestAnimationFrame(scanFrame)
  return { stop }
}
