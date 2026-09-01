# Governance

## Project scope

`dsh-community` is maintained as an independent community distribution,
compatibility, and verification layer around the published DeepSeek Harness
Runtime. The project does not claim to be an official DeepSeek client and does
not own the upstream Agent Runtime.

## Current maintainership

The repository owner currently acts as the primary maintainer. This is a
single-maintainer project today; this document does not claim a larger
maintainer team.

The primary maintainer is responsible for:

- triaging public issues and external contribution requests;
- reviewing changes against the architectural boundaries in
  [ARCHITECTURE.md](ARCHITECTURE.md);
- deciding when an upstream DSH version is eligible for the compatibility
  matrix;
- reviewing marketplace compatibility/security metadata;
- cutting and validating community releases;
- responding to security reports according to [SECURITY.md](SECURITY.md).

## Decision policy

Changes are accepted on evidence, not on who submitted them. A change that
modifies Runtime, Session, permission, plugin-install, network, or release
behavior must explain that boundary and include reproducible validation.

The following require maintainer review before merge:

- upstream Runtime pin changes;
- release workflow or signing changes;
- new runtime dependencies;
- new or materially changed marketplace entries;
- permission, IPC, navigation, filesystem, process-execution, or credential
  handling changes;
- changes to the architectural ownership boundary.

## Releases

GitHub Releases are created from this repository's release workflow. Published
assets, checksums, and keyless signature bundles are release evidence; a local
build is not a published release.

A compatibility matrix entry or README statement must not claim a stronger
verification level than the evidence actually run. `[UNVERIFIED]`,
`[PARTIAL]`, and similar labels are intentional and should remain until the
corresponding validation is completed.

## External contributors

External issues and pull requests are welcome. Contributors do not need prior
membership or affiliation. Registry submissions follow
[packages/marketplace/docs/registry-guide.md](packages/marketplace/docs/registry-guide.md).

As contribution volume grows, additional maintainers may be added based on
sustained review-quality contributions and demonstrated understanding of the
project's runtime/security boundaries.
