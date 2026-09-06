/**
 * Shared PDF rendering (FSD 5.13).
 *
 * pdfmake's server-side PdfPrinter needs a font descriptor, but not
 * necessarily font FILES — the standard 14 PostScript fonts (Helvetica among
 * them) are baked into @foliojs-fork/pdfkit (pdfmake's own PDF engine
 * dependency) as name references, with no TTF to source or license. That's
 * the only reason this doesn't need a fonts/ directory shipped with the repo.
 */
import PdfPrinter from 'pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

const FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
  // The certificate's display face — a serif reads as "certificate"
  // immediately in a way Helvetica never will, and Times-Roman is one of
  // the standard 14 fonts, so it costs nothing beyond declaring it here.
  Times: {
    normal: 'Times-Roman',
    bold: 'Times-Bold',
    italics: 'Times-Italic',
    bolditalics: 'Times-BoldItalic',
  },
};

export function renderPdf(docDefinition: TDocumentDefinitions): Promise<Buffer> {
  const printer = new PdfPrinter(FONTS);
  const doc = printer.createPdfKitDocument({
    pageSize: 'A4',
    pageMargins: [36, 48, 36, 48],
    defaultStyle: { font: 'Helvetica', fontSize: 9 },
    styles: {
      title: { fontSize: 16, bold: true, margin: [0, 0, 0, 2] },
      subtitle: { fontSize: 10, color: '#555555', margin: [0, 0, 0, 12] },
      sectionHeader: { fontSize: 12, bold: true, margin: [0, 14, 0, 6] },
      tableHeader: { bold: true, fontSize: 8.5, color: '#ffffff', fillColor: '#3b36ad' },
      watermark: { fontSize: 10, bold: true, color: '#9c6b12', margin: [0, 0, 0, 10] },
    },
    ...docDefinition,
  });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
