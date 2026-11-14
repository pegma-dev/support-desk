# @pegma/support-desk-templates

The synchronized `0.2.12` release is published and strictly verified. See the
[publication receipt](../../docs/RELEASING.md#verified-0212-publication-2026-11-14),
[release notes](../../docs/RELEASE_NOTES.md#0212-opt-in-provider-group-checks)
and [engineering read phases](../../docs/ENGINEERING_EXPORT.md#entry-points-and-authority). This package adds no new runtime API.

The current verified synchronized registry release is `0.2.12`; see the
[publication receipt](../../docs/RELEASING.md#verified-0212-publication-2026-11-14).
The synchronized `0.2.12` release retains the
[application/AI additions](../../docs/RELEASE_NOTES.md). Host adoption retains
its own composition and activation gates.

Small, non-executable notification templates. Definitions have an explicit
variable allowlist and immutable numeric version. Rendering always creates
plain-text and HTML alternatives, escaping every variable in HTML context.
Variables placed in URL-bearing attributes must be explicitly declared as
HTTPS URL variables; script schemes and credential-bearing URLs are rejected
before interpolation.

HTML is not arbitrary: only paragraphs, emphasis, lists, code, line breaks,
and anchors whose entire `href` is a declared HTTPS URL variable are accepted.
Scripts, active elements, event handlers, style/source attributes, undeclared
URL attributes, and malformed markup are rejected when the template is
defined.

The optional `retiregolden` export is a host-branded pack, kept separate from
the generic renderer.

Task 13 staff tags, response targets, and milestones are not customer template
variables. Keep host-supplied customer notification maps free of this metadata;
the generic renderer receives only the explicitly supplied variable allowlist.

Task 15's staff canned responses, published in `0.2.9`, are separate plain-text
reply/note definitions, validated and expanded by core and application. See
[host composition](../../docs/HOST_COMPOSITION.md#staff-canned-responses-task-15-source-candidate).
Keep their catalog, internal-note text and template provenance out of customer
notification maps. A public reply's approved body can be supplied as a normal
allowlisted notification variable; `renderTemplate` escapes it in HTML context.
Do not splice that text into template HTML or evaluate it as template source.
