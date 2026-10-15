import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  PDFObjectParser,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import ByteStream from 'pdf-lib/es/core/parser/ByteStream';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { lookupRef, type SourceImage } from './pdfSourceImages';
import { nativeImages, nativeOriginalImage } from './pdfiumImages';

/** Build a document containing only the encoded source image and its intrinsic
 * color/mask resources. Page clips, opacity, blend modes and ink do not belong
 * to the original image. The caller owns and terminates this isolated heap. */
export async function decodeSourceImage(
  api: WrappedPdfiumModule,
  source: PDFDocument,
  image: SourceImage,
  maxPixels: number,
  check: () => void,
) {
  if (image.width * image.height > 64_000_000 || Math.max(image.width, image.height) > 32767)
    return null;
  let stream: PDFRawStream;
  if (image.ref) {
    const object = lookupRef(source, image.ref);
    if (!(object instanceof PDFRawStream)) throw new Error('PDF image stream unavailable');
    stream = object;
  } else if (image.inline) {
    const object = lookupRef(source, image.inline.stream);
    if (!(object instanceof PDFRawStream)) throw new Error('PDF inline source unavailable');
    const dict = PDFObjectParser.forByteStream(
      ByteStream.of(new TextEncoder().encode(image.inline.dict)) as unknown as Parameters<
        typeof PDFObjectParser.forByteStream
      >[0],
      source.context,
    ).parseObject();
    if (!(dict instanceof PDFDict)) throw new Error('PDF inline dictionary unavailable');
    stream = PDFRawStream.of(
      dict,
      decodePDFRawStream(object).decode().subarray(image.inline.start, image.inline.end),
    );
  } else return null;
  check();
  const target = await PDFDocument.create(),
    copier = PDFObjectCopier.for(source.context, target.context);
  const copied = copier.copy(stream);
  copied.dict.delete(PDFName.of('OC'));
  copied.dict.delete(PDFName.of('StructParent'));
  const resources = target.context.obj({ XObject: { Source: target.context.register(copied) } });
  let owner = lookupRef(source, image.owner),
    depth = 0;
  while (owner instanceof PDFDict || owner instanceof PDFRawStream) {
    const dict = owner instanceof PDFRawStream ? owner.dict : owner;
    const own = dict.lookup(PDFName.of('Resources'));
    if (own instanceof PDFDict) {
      const colors = own.lookup(PDFName.of('ColorSpace'));
      if (colors) resources.set(PDFName.of('ColorSpace'), copier.copy(colors));
      break;
    }
    if (++depth > 32) break;
    owner = dict.lookup(PDFName.of('Parent'));
  }
  const page = target.addPage([image.width, image.height]);
  page.node.set(PDFName.of('Resources'), resources);
  page.node.set(
    PDFName.of('Contents'),
    target.context.register(
      target.context.flateStream(`q ${image.width} 0 0 ${image.height} 0 0 cm /Source Do Q`),
    ),
  );
  const bytes = await target.save({ useObjectStreams: false });
  check();
  const memory = api.pdfium as typeof api.pdfium & { HEAPU8: Uint8Array };
  const pointer = memory.wasmExports.malloc(bytes.length);
  if (!pointer) throw new Error('PDF source image allocation failed');
  let document = 0,
    handle = 0;
  try {
    memory.HEAPU8.set(bytes, pointer);
    document = api.FPDF_LoadMemDocument(pointer, bytes.length, '');
    if (!document) throw new Error('PDF source image document unavailable');
    handle = api.FPDF_LoadPage(document, 0);
    if (!handle) throw new Error('PDF source image page unavailable');
    const [object] = await nativeImages(api, handle, check);
    return object ? nativeOriginalImage(api, document, handle, object, maxPixels) : null;
  } finally {
    if (handle) api.FPDF_ClosePage(handle);
    if (document) api.FPDF_CloseDocument(document);
    memory.wasmExports.free(pointer);
  }
}
