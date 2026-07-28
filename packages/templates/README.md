# @pegma/support-desk-templates

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
