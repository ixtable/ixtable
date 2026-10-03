import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

let lastMs = 0;
let sequence = 0;

/**
 * Stable identifier for new definition objects (PRD: display names are not identity):
 * a UUIDv7 (RFC 9562), so ids sort by creation time. Ids made in the same millisecond
 * stay ordered through a 12-bit counter in `rand_a`.
 */
export function newId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let ms = Date.now();
  if (ms > lastMs) {
    lastMs = ms;
    sequence = ((bytes[6] & 0x07) << 8) | bytes[7];
  } else {
    ms = lastMs;
    sequence += 1;
    if (sequence > 0xfff) {
      lastMs += 1;
      ms = lastMs;
      sequence = 0;
    }
  }
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | (sequence >> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
