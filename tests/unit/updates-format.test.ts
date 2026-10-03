import { expect, it } from "vitest";
import { describeProgress, describeUpdateError, formatBytes } from "../../src/updates/format";

it("formats download progress", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  expect(describeProgress({ phase: "downloading", downloaded: 512, total: 2048 })).toBe(
    "Downloaded 512 B of 2.0 KB (25%)",
  );
  expect(describeProgress({ phase: "downloading", downloaded: 2048, total: null })).toBe(
    "Downloaded 2.0 KB",
  );
  expect(describeProgress({ phase: "installing", downloaded: 1, total: 1 })).toMatch(/Verifying/);
});

it("explains signature failures without the raw minisign text", () => {
  expect(describeUpdateError("UPDATE_SIGNATURE_INVALID", "minisign: bad")).toBe(
    "The downloaded update failed signature verification and was not installed.",
  );
  expect(describeUpdateError("UPDATE_FAILED", "Network down")).toBe("Network down");
});
