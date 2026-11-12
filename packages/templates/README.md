# @pegma/support-desk-templates

The local synchronized source version is `0.2.8`. See the
[release notes](../../docs/RELEASE_NOTES.md#028-followup-mutation-guards)
and [engineering read phases](../../docs/ENGINEERING_EXPORT.md#entry-points-and-authority). This package adds no new runtime API.

The current verified synchronized registry release is `0.2.7`; see the
[publication receipt](../../docs/RELEASING.md#verified-027-publication-2026-11-11).
The synchronized `0.2.7` release includes the
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
