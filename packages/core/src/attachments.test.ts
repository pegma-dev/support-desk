import { expect, it } from "vitest";
import { normalizeAttachmentFilename } from "./index.js";

it("normalizes hostile display filenames independently of blob keys", () => {
  expect(normalizeAttachmentFilename('../bad\u0000\r\n"file.html', 80)).toBe(
    "_bad____file.html",
  );
  expect(normalizeAttachmentFilename("...", 80)).toBe("attachment");
});
