/**
 * Image XObjects for the PDF writer without decoding pixels:
 * JPEG passes through as DCTDecode; PNG IDAT data passes through as
 * FlateDecode with the PNG predictor (non-interlaced gray, RGB and palette
 * images, at most 8 bits per sample, as PDF 1.4 allows). Other PNGs (alpha,
 * tRNS transparency, interlacing, 16-bit samples) are decoded by
 * Rust (`prepare_report_pdf`) into color samples plus a soft mask.
 */

export interface PdfImage {
  /** Image dictionary entries after /Type /XObject /Subtype /Image (without /Length). */
  dict: string;
  data: Uint8Array;
  /** 8-bit alpha samples (FlateDecode), written as the image's /SMask. */
  smask?: { dict: string; data: Uint8Array };
}

/** A PNG decoded by `prepare_report_pdf`: zlib-compressed 8-bit samples. */
export interface DecodedPng {
  width: number;
  height: number;
  colors: 1 | 3;
  colorBase64: string;
  alphaBase64?: string | null;
}

/** Image XObject of a decoded PNG, with its alpha as a soft mask. */
export function decodedImage(png: DecodedPng, bytes: (b64: string) => Uint8Array): PdfImage {
  const size = `/Width ${png.width} /Height ${png.height}`;
  const space = png.colors === 1 ? "/DeviceGray" : "/DeviceRGB";
  return {
    dict: `${size} /ColorSpace ${space} /BitsPerComponent 8 /Filter /FlateDecode`,
    data: bytes(png.colorBase64),
    smask: png.alphaBase64
      ? {
          dict: `${size} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
          data: bytes(png.alphaBase64),
        }
      : undefined,
  };
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) =>
  ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

/** Reads JPEG dimensions and components from the first SOFn marker. */
export function jpegImage(data: Uint8Array): PdfImage | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    const length = be16(data, i + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = be16(data, i + 5);
      const width = be16(data, i + 7);
      const components = data[i + 9];
      const space =
        components === 1 ? "/DeviceGray" : components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
      const decode = components === 4 ? " /Decode [1 0 1 0 1 0 1 0]" : "";
      if (!width || !height) return null;
      return {
        dict: `/Width ${width} /Height ${height} /ColorSpace ${space} /BitsPerComponent 8${decode} /Filter /DCTDecode`,
        data,
      };
    }
    i += 2 + length;
  }
  return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG passthrough for opaque non-interlaced 8-bit-or-less grayscale, RGB and palette images. */
export function pngImage(data: Uint8Array): PdfImage | null {
  if (!PNG_SIGNATURE.every((b, i) => data[i] === b)) return null;
  let i = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (i + 8 <= data.length) {
    const length = be32(data, i);
    const type = String.fromCharCode(data[i + 4], data[i + 5], data[i + 6], data[i + 7]);
    const body = data.subarray(i + 8, i + 8 + length);
    if (type === "IHDR") {
      width = be32(body, 0);
      height = be32(body, 4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "PLTE") palette = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "tRNS") return null;
    else if (type === "IEND") break;
    i += 12 + length;
  }
  // 16-bit samples need PDF 1.5; Rust strips them to 8 bits instead.
  if (!width || !height || interlace !== 0 || depth > 8 || !idat.length) return null;
  let colors: number;
  let space: string;
  if (colorType === 0) {
    colors = 1;
    space = "/DeviceGray";
  } else if (colorType === 2 && depth === 8) {
    colors = 3;
    space = "/DeviceRGB";
  } else if (colorType === 3 && palette && depth <= 8) {
    colors = 1;
    const hex = [...palette].map((b) => b.toString(16).padStart(2, "0")).join("");
    space = `[/Indexed /DeviceRGB ${palette.length / 3 - 1} <${hex}>]`;
  } else return null;
  const total = idat.reduce((n, part) => n + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of idat) {
    joined.set(part, offset);
    offset += part.length;
  }
  return {
    dict:
      `/Width ${width} /Height ${height} /ColorSpace ${space} /BitsPerComponent ${depth}` +
      ` /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${depth} /Columns ${width} >>`,
    data: joined,
  };
}

export function pdfImage(mediaType: string, data: Uint8Array): PdfImage | null {
  if (mediaType === "image/jpeg") return jpegImage(data);
  if (mediaType === "image/png") return pngImage(data);
  return null;
}
