// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * The tests model a checkout rooted at the test process's cwd. On a GitHub
 * runner GITHUB_WORKSPACE is the repository root (above this package), and
 * repoRoot() rightly prefers it, so pin it here to keep path expectations
 * independent of where the suite runs.
 */
process.env.GITHUB_WORKSPACE = process.cwd();
