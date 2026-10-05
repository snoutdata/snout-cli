// One file, no dependencies, `npx snoutdata` away.
//
// The CLI is bundled rather than published as a tree of modules because the thing it
// competes with is `npx` latency: an agent that has to install a dependency graph before
// it can ask for a database will use something else.
import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// SnoutData's own build adds two things a public checkout has no source for: the shared code is
// copied in fresh before anything compiles (`--prepare`, run first by `npm run build`), and the
// local pod runtime behind `snoutdata start` is bundled in. Both come from deploy/monorepo.mjs,
// which is not in the public repository; without it the CLI builds with every command but that
// one, which then says the runtime is not available to this build.
const monorepoHook = new URL('./deploy/monorepo.mjs', import.meta.url);
const monorepo = existsSync(monorepoHook) ? await import(monorepoHook.href) : null;
if (process.argv.includes('--prepare')) {
	monorepo?.sync();
	process.exit(0);
}

// The Google "Desktop app" OAuth client `snoutdata login` signs in with (src/commands/login.ts).
// It is not in the source because the source is mirrored to a public repository, where GitHub's
// push protection refuses a Google client secret. It IS in every bundle, which is what Google
// expects of an installed app, so a build without it refuses rather than shipping a CLI whose
// Google sign-in fails. From the environment (the release workflow's secrets), else from a
// gitignored .env.local beside this file.
//
// `--google-optional` is for a TEST build (SnoutData's cloud QA pass), which drives a CLI that is
// already signed in and never runs `login`: the client is used when it is configured, and when it
// is not the bundle has no Google sign-in, and `snoutdata login` says so instead of sending the
// browser to Google with nothing. Nothing that publishes passes it, and deploy/audit.sh refuses a
// packed bundle without the client, so a build like this cannot reach npm.
const googleOptional = process.argv.includes('--google-optional');
function googleClient(name) {
	if (process.env[name]) {
		return process.env[name];
	}
	try {
		const line = readFileSync(new URL('./.env.local', import.meta.url), 'utf8')
			.split(/\r?\n/)
			.find((l) => l.startsWith(`${name}=`));
		if (line) {
			return line.slice(name.length + 1).trim();
		}
	} catch {
		// no .env.local: fall through to the refusal
	}
	if (googleOptional) {
		return '';
	}
	throw new Error(`${name} is not set (environment or .env.local beside build.mjs). \`snoutdata login\` with Google would fail for everyone.`);
}
const googleClientId = googleClient('SNOUTDATA_GOOGLE_CLIENT_ID');
const googleClientSecret = googleClient('SNOUTDATA_GOOGLE_CLIENT_SECRET');
if (!googleClientId && !googleClientSecret) {
	console.log('built WITHOUT Google sign-in (--google-optional and no client configured): a test build, not for release');
} else if (!googleClientId.endsWith('.apps.googleusercontent.com') || !googleClientSecret.startsWith('GOCSPX-')) {
	throw new Error('SNOUTDATA_GOOGLE_CLIENT_ID / SNOUTDATA_GOOGLE_CLIENT_SECRET do not look like a Google OAuth client.');
}

await build({
	entryPoints: ['src/main.ts'],
	outfile: 'dist/snoutdata.mjs',
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	banner: { js: '#!/usr/bin/env node' },
	// Minified, and it is worth being honest about what that is and is not. It is NOT
	// protection: anything shipped to a user's machine can be read, and this is a speed
	// bump in front of a determined reader. What it does buy is that npm's "Code" tab
	// stops being a browsable copy of the implementation, and the tarball is smaller,
	// which is the same argument as bundling above. 0.1.0 shipped unminified, which was
	// not a decision anybody made.
	// The single source of the version. It used to be a constant in main.ts, and 0.1.1 went
	// out saying 0.1.0 because a release bumps package.json and nothing else.
	define: {
		__SNOUTDATA_VERSION__: JSON.stringify(version),
		__SNOUTDATA_GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId),
		__SNOUTDATA_GOOGLE_CLIENT_SECRET__: JSON.stringify(googleClientSecret)
	},
	// The local pod runtime goes IN, and this alias is the whole of how.
	//
	// `@snout/snoutpod` is not on npm, so a published CLI
	// that merely IMPORTED it could not resolve it: 0.2.0 answered "the local pod runtime is not
	// available to this build of the CLI" to every `snoutdata start`, which is the command the local
	// runtime exists for. Aliasing the specifier to the source puts it in the one file instead. It costs
	// nothing at startup — `loadRuntime` keeps it behind an `import()` — and it adds no dependency,
	// because that package has none but `@types/node`.
	//
	// The source and not `dist/`, so a build here cannot silently use a stale compile of it.
	alias: monorepo ? { '@snout/snoutpod/local': monorepo.localRuntime } : {},
	external: monorepo ? [] : ['@snout/snoutpod/local'],
	minify: true,
	logLevel: 'info'
});

// Assert what was just built, rather than trusting that it built.
//
// `snoutdata start` is the command the local runtime exists for, and 0.2.0 shipped unable to run it: the
// runtime was reached through a VARIABLE specifier, which no bundler can follow, so the published
// file asked every user to point an environment variable at a checkout they do not have. Nothing
// caught it because every test and every hand-run drove the checkout, where the variable is set.
//
// So the build says out loud that the runtime is in the file. Two checks, and neither is a
// substitute for running the packed tarball before a release:
//
//   1. A sentence that exists only in the pod runtime is present. If the alias above stops
//      resolving, esbuild marks the import external and this string disappears.
//   2. No bare `@snout/snoutpod` specifier survives. That is the same failure by the other route:
//      an import esbuild left for Node to resolve at run time, against a package that is not
//      published and never will be.
//
// What this deliberately does NOT assert is that the runtime stays LAZY. It is lazy (esbuild
// compiles the literal `import()` to a deferred init, checked by hand on 2026-09-11), and if it
// ever became a top-level import the cost would be a PATH walk at startup rather than a broken
// command — a regression worth avoiding and not worth a brittle assertion against minified output.
if (!monorepo) {
	console.log('built without the local pod runtime: `snoutdata start` needs SnoutData\'s own build');
	process.exit(0);
}
const built = readFileSync(new URL('./dist/snoutdata.mjs', import.meta.url), 'utf8');
const mustContain = 'winget install RedHat.Podman';
if (!built.includes(mustContain)) {
	throw new Error(
		`the local pod runtime is not in dist/snoutdata.mjs (looked for ${JSON.stringify(mustContain)}). ` +
			'`snoutdata start` would fail for everyone who installs this. Check the alias above.'
	);
}
if (/['"`]@snout\/snoutpod/.test(built)) {
	throw new Error(
		'dist/snoutdata.mjs still names @snout/snoutpod, so esbuild left it for Node to resolve at ' +
			'run time against a package that is not on npm. Check the alias above.'
	);
}
console.log('ok: the local pod runtime is in the bundle');
