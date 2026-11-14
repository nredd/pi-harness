#!/usr/bin/env bash
# Compatibility launcher for the MIT-derived Node port. This wrapper is not Node coverage.
exec node "$(dirname "$0")/make-signing-cert.mjs" "$@"
