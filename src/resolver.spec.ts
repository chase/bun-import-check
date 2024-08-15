import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, relative, resolve } from 'node:path';
import type { ResolversByDir } from './resolver';
import { getResolvers, resolveAmbiguous } from './resolver';

const FILE_UNDER_TEST = resolve(
	import.meta.dir,
	'../example-monorepo/packages/primary/index.ts',
);
const FILE_DIR = dirname(FILE_UNDER_TEST);

let resolversByDir: ResolversByDir;
beforeAll(async () => {
	resolversByDir = await getResolvers(FILE_UNDER_TEST);
});

function assert<T>(x: T): asserts x is NonNullable<T> {
	expect(x).not.toBeNil();
}

test('resolves workspace packages', async () => {
	const package_ = await resolveAmbiguous(
		resolversByDir,
		'@org/secondary',
		FILE_UNDER_TEST,
	);
	assert(package_);
	expect(relative(FILE_DIR, package_)).toBe('../secondary/index.ts');
});

test('resolves npm package', async () => {
	const package_ = await resolveAmbiguous(
		resolversByDir,
		'typescript',
		FILE_UNDER_TEST,
	);
	assert(package_);
	expect(relative(FILE_DIR, package_)).toStartWith(
		'../../node_modules/typescript',
	);
});

test('resolves with baseUrl', async () => {
	const package_ = await resolveAmbiguous(resolversByDir, 'a', FILE_UNDER_TEST);
	assert(package_);
	expect(relative(FILE_DIR, package_)).toBe('a.ts');
});

describe('tsconfig paths', () => {
	test('without glob', async () => {
		const package_ = await resolveAmbiguous(
			resolversByDir,
			'@utils',
			FILE_UNDER_TEST,
		);
		assert(package_);
		expect(relative(FILE_DIR, package_)).toBe('utils/index.ts');
	});

	test('with duplicated glob in extended', async () => {
		const package_ = await resolveAmbiguous(
			resolversByDir,
			'@utils/a',
			FILE_UNDER_TEST,
		);
		assert(package_);
		expect(relative(FILE_DIR, package_)).toBe('utils/a.js');
	});

	test('with unique glob in extending', async () => {
		const package_ = await resolveAmbiguous(
			resolversByDir,
			'@private/a',
			FILE_UNDER_TEST,
		);
		assert(package_);
		expect(relative(FILE_DIR, package_)).toBe('private/a.ts');
	});

	test('with glob from parent config', async () => {
		const package_ = await resolveAmbiguous(
			resolversByDir,
			'@primary/b',
			FILE_UNDER_TEST,
		);
		assert(package_);
		expect(relative(FILE_DIR, package_)).toBe('b.ts');
	});
});
