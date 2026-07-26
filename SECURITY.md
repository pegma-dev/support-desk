# Security Policy

Support Desk processes customer conversations, email addresses, staff actions,
and potentially sensitive attachments. Please report suspected vulnerabilities
privately.

## Reporting a vulnerability

Use
[GitHub private vulnerability reporting](https://github.com/pegma-dev/support-desk/security/advisories/new).
Do not open a public issue.

Include, when possible:

- the affected package, endpoint, or commit;
- a minimal reproduction using synthetic data;
- the expected and observed behavior;
- potential confidentiality, integrity, or authorization impact;
- any suggested mitigation.

We will acknowledge a complete report as soon as practical, investigate it, and
coordinate remediation and disclosure with the reporter. Do not access
conversations that are not yours or disrupt production systems while
researching a report.

## Supported versions

Support Desk is pre-release software. Until the first stable release, only the
latest commit on the default branch is supported.

## Host responsibilities

Applications integrating Support Desk remain responsible for:

- authenticating customers and staff;
- enforcing permissions on every server-side operation;
- validating inbound mail-provider webhook signatures;
- verifying outbound delivery callbacks;
- applying idempotency to inbound and outbound events;
- sanitizing rendered message content;
- scanning and restricting attachments;
- protecting mail, storage, signing, and AI-provider credentials;
- encrypting sensitive data and establishing retention policies;
- preventing secrets and customer data from entering logs or model prompts.

An email-address match can help associate a ticket with an account, but it does
not authenticate the sender or grant access to that account.
