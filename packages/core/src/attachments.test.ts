import { expect, it } from "vitest";
import { normalizeAttachmentFilename } from "./index.js";

it("normalizes hostile display filenames independently of blob keys", () => {
  expect(normalizeAttachmentFilename('../bad\u0000\r\n"file.html', 80)).toBe(
    "_bad____file.html",
  );
  expect(normalizeAttachmentFilename("...", 80)).toBe("attachment");
});

it.each([1, 3, 9, 10, 255])(
  "bounds fallback display names at %i characters",
  (maximum) => {
    const expected = "attachment".slice(0, maximum);
    expect(normalizeAttachmentFilename("...", maximum)).toBe(expected);
    expect(normalizeAttachmentFilename(" ... ", maximum)).toBe(expected);
    expect(normalizeAttachmentFilename("", maximum)).toBe(expected);
  },
);

it.each([" ..file.txt", "   ...file.txt", "\u2002..file.txt"])(
  "removes leading dots after trimming %s",
  (value) => {
    expect(normalizeAttachmentFilename(value, 80)).toBe("file.txt");
  },
);
