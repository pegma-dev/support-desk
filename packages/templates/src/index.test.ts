import { describe, expect, it } from "vitest";
import { defineTemplate, previewTemplate, renderTemplate } from "./index.js";

describe("safe templates", () => {
  const template = defineTemplate({
    id: "customer.reply",
    version: 2,
    variables: ["body", "url"],
    httpsUrlVariables: ["url"],
    plainText: "{{body}}\n{{url}}",
    html: '<p>{{body}}</p><a href="{{url}}">Open</a>',
  });

  it("escapes every HTML variable while preserving the plain alternative", () => {
    const rendered = renderTemplate(template, {
      body: "<img src=x onerror=alert(1)>",
      url: "https://example.test/?a=1&b=2",
    });
    expect(rendered.plainText).toContain("<img");
    expect(rendered.html).toContain("&lt;img");
    expect(rendered.html).not.toContain("<img");
    expect(rendered.templateVersion).toBe(2);
  });

  it("rejects undeclared expressions and extra variables", () => {
    expect(() =>
      defineTemplate({
        id: "unsafe",
        version: 1,
        variables: [],
        plainText: "{{secret}}",
        html: "<p>safe</p>",
      }),
    ).toThrow(/unlisted variable/);
    expect(() =>
      renderTemplate(template, {
        body: "safe",
        url: "https://example.test",
        secret: "not allowed",
      }),
    ).toThrow(/not allowed/);
  });

  it("supports deterministic synthetic preview", () => {
    const preview = previewTemplate(template);
    expect(preview.plainText).toContain("[preview:body]");
    expect(preview.plainText).toContain("https://preview.invalid/url");
  });

  it("rejects script URLs in URL-context variables", () => {
    expect(() =>
      renderTemplate(template, {
        body: "safe",
        url: "javascript:alert(document.domain)",
      }),
    ).toThrow(/absolute HTTPS/);
  });

  it("rejects URL attributes without annotation and active literal HTML", () => {
    expect(() =>
      defineTemplate({
        id: "missing-url-context",
        version: 1,
        variables: ["url"],
        plainText: "{{url}}",
        html: '<a href="{{url}}">Open</a>',
      }),
    ).toThrow(/safe subset/);
    expect(() =>
      defineTemplate({
        id: "active-html",
        version: 1,
        variables: [],
        plainText: "Safe",
        html: '<p onclick="alert(1)">Unsafe</p><script>alert(1)</script>',
      }),
    ).toThrow(/safe subset/);
  });

  it("revalidates raw structural definitions at render time", () => {
    expect(() =>
      renderTemplate(
        {
          id: "catalog.raw",
          version: 1,
          variables: ["url"],
          httpsUrlVariables: ["url"],
          plainText: "{{url}}",
          html: '<script src="{{url}}"></script>',
        },
        { url: "https://example.test/script.js" },
      ),
    ).toThrow(/safe subset/);
  });

  it("rejects changing accessors without executing them", () => {
    let htmlReads = 0;
    const rawTemplate = {
      id: "catalog.getter",
      version: 1,
      variables: ["url"],
      httpsUrlVariables: ["url"],
      plainText: "{{url}}",
      get html() {
        htmlReads += 1;
        return htmlReads < 4
          ? '<a href="{{url}}">Open</a>'
          : "<script>alert(1)</script>";
      },
    };
    expect(() =>
      renderTemplate(rawTemplate, { url: "https://example.test" }),
    ).toThrow(/own data property/);
    expect(htmlReads).toBe(0);
    expect(() => previewTemplate(rawTemplate)).toThrow(/own data property/);
    expect(htmlReads).toBe(0);

    let urlReads = 0;
    expect(() =>
      renderTemplate(template, {
        body: "safe",
        get url() {
          urlReads += 1;
          return urlReads === 1
            ? "https://example.test"
            : "javascript:alert(1)";
        },
      }),
    ).toThrow(/own data property/);
    expect(urlReads).toBe(0);
  });
});
