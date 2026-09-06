/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

/**
 * Not yet in this TS version's lib.dom.d.ts. Chrome/Edge/Android support it
 * natively; JDG-03-04's barcode/QR scan feature-detects and falls back to
 * hiding the scan button where it's absent (e.g. iOS Safari).
 */
interface BarcodeDetectorOptions {
  formats?: string[];
}
interface DetectedBarcode {
  rawValue: string;
  format: string;
}
declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  static getSupportedFormats(): Promise<string[]>;
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
