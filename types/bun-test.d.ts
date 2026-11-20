// The `bun:test` module only: the code itself runs on Node in production, so Bun's
// global types (its fetch, Request, …) stay out of the type check.
/// <reference path="../node_modules/bun-types/test.d.ts" />
