# Security Policy

## Supported Versions

We actively support and provide security patches for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

We take the security of DeepSeek Harness Suite seriously. If you discover a security vulnerability, please follow responsible disclosure guidelines:

1. **Do not disclose publicly**: Do not create public GitHub issues for security vulnerabilities.
2. **Email disclosure**: Please report security vulnerabilities to the maintainers or via GitHub Private Vulnerability Reporting.
3. **Information to include**:
   - Step-by-step reproduction instructions or proof-of-concept
   - Impact assessment
   - Affected platform / environment

## Security Invariants

* **Official Source Ownership = 0**: Zero vendored upstream code.
* **Process Isolation**: All child processes must be cleaned up on SIGINT/SIGTERM.
* **Sensitive File Defense**: `.dshignore` automatically flags access to `.env`, private keys (`*.pem`, `*.key`, `id_rsa`), and credentials. Built-in sensitive rules compare case-insensitively; custom patterns are matched literally (no glob/negation support — unsupported syntax warns once on stderr).
* **Tamper-Evident Audit**: SHA-256 hash chains cryptographically record tool executions.
