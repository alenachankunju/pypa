/**
 * JDG-03-04: badge scan via the device camera, using the native BarcodeDetector
 * API rather than a bundled scanning library — this is an optional convenience
 * on top of the text search, not the primary lookup path, so a browser that
 * lacks it (notably iOS Safari, as of this writing) simply doesn't offer the
 * button rather than shipping a fallback decoder.
 */
import { useEffect, useRef, useState } from 'react';
import { ErrorState } from '../../components/ui';

export function scannerSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

export function BadgeScanner({
  onDetected,
  onCancel,
}: {
  onDetected: (value: string) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let frame = 0;

    async function run() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const detector = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'code_39'] });

        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0 && codes[0]) {
              onDetected(codes[0].rawValue);
              return;
            }
          } catch {
            // A single failed detect (e.g. a blurry frame) isn't fatal — keep scanning.
          }
          frame = window.requestAnimationFrame(() => void tick());
        };
        frame = window.requestAnimationFrame(() => void tick());
      } catch (err) {
        setError(err);
      }
    }

    void run();

    return () => {
      stopped = true;
      if (frame) window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="stack">
        <ErrorState error={error} />
        <p className="text-sm muted">Could not access the camera. Check the browser's camera permission, or use the text field instead.</p>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <video ref={videoRef} playsInline muted style={{ width: '100%', borderRadius: 'var(--radius-md)', background: '#000' }} />
      <p className="text-sm muted">Point the camera at the badge's barcode or QR code.</p>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
