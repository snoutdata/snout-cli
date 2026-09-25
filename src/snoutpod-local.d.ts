/**
 * The pod runtime, as a name this package can compile against.
 *
 * `@snout/snoutpod` is a private package in this repo, and `apps/cli` deliberately does not depend
 * on it: the published CLI is one bundled file with no dependencies, which is most of why
 * `npx snoutdata` is quick. The build ALIASES the specifier to that package's source
 * (`build.mjs`), so the module exists at bundle time and not at typecheck time.
 *
 * Shorthand on purpose, which makes the import `any`. The shape that matters is asserted at the
 * one call site by the `SnoutpodLocal` interface in `commands/local.ts`, which is written out by the
 * CONSUMER — declaring a second, fuller copy of it here would be two descriptions of one thing.
 */
declare module '@snout/snoutpod/local';
