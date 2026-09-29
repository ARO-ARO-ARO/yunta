# Changelog

## 0.1.0

- First public functional release of YUNTA.
- Added an MCP stdio server for controlled WordPress draft creation.
- Added the `wordpress.create_draft` tool using the WordPress REST API.
- Added security validation for WordPress targets and bounded tool inputs.
- Added local durable audit records and explicit handling of ambiguous execution outcomes.
- Added safe failure observability in private audit records without exposing sensitive exception details through MCP.
- Added a portable Windows x64 executable built with Node SEA; it runs as an MCP stdio server without a separate Node installation.
- Added minimal public YUNTA branding and documented its relationship with ARO ARO ARO.
- Added automated coverage for MCP stdio behavior and WordPress draft creation.
