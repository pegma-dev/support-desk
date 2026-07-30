# Release notes

## 0.1.0 — first advertised supported release

Status: published. All four packages are on the public npm registry at exact
`0.1.0`, and the signed annotated `v0.1.0` tag and its GitHub release mark
the release commit. Hosts may depend on the published packages; a Git branch,
copied source, local path, or unpublished tarball remains forbidden as a
production dependency.

### Packages

| Package                           | Version |
| --------------------------------- | ------- |
| `@pegma/support-desk-contracts`   | `0.1.0` |
| `@pegma/support-desk-core`        | `0.1.0` |
| `@pegma/support-desk-templates`   | `0.1.0` |
| `@pegma/support-desk-application` | `0.1.0` |

### Surface

- provider-neutral ticket, message, requester, and lifecycle contracts;
- pure ticket creation and revisioned workflow transitions;
- authorized customer create/list/read/reply with safe customer DTOs;
- authorized staff detail, mutations, audit history, and repairable queue
  projection;
- transactional `@pegma/audit@0.1.0` accepted-change records and
  `@pegma/mail@0.1.0` delivery projection in the ticket partition;
- safe versioned templates with an optional RetireGolden-branded pack export;
- host-owned worker entry points for mail send/reconcile/sweep, queue repair
  and inactive-row sweep, customer-index prune, and receipt sweeps.

### Exact dependencies

- `@pegma/spine@0.1.1`
- `@pegma/storage-core@0.4.0`
- `@pegma/authorization-core@0.1.2`
- `@pegma/audit@0.1.0`
- `@pegma/mail@0.1.0`

### Host integration

See [HOST_COMPOSITION.md](HOST_COMPOSITION.md) for error-to-HTTP mapping and
scheduler ownership, [RELEASING.md](RELEASING.md) for publication, and
[examples/composition](../examples/composition/README.md) for a memory-backed
end-to-end composition with no framework.
