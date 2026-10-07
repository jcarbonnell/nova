//! The host's sensitive-marker words (ironclaw-v1.4.1:
//! ironclaw_threads/src/tool_result_reference.rs SENSITIVE_OBSERVATION_MARKERS,
//! plus ironclaw_host_api/src/credential_redaction.rs CREDENTIAL_MARKERS).
//! A failure message containing any of these is dropped from the model's view.
//! Kept in its own file so lib.rs can be scanned for them by a unit test.

pub const SENSITIVE_MARKERS: &[&str] = &[
    "access token",
    "api key",
    "api_key",
    "apikey",
    "authorization:",
    "bearer ",
    "client_secret",
    "host path",
    "invalid api key",
    "invalid_api_key",
    "password",
    "passwd",
    "private key",
    "private_key",
    "raw credential",
    "raw runtime",
    "secret",
    "stack trace",
    "traceback",
    "tool_input",
];