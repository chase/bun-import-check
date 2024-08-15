import { describe, expect, test } from 'bun:test';
import { hasImport } from './import'; // Replace with the actual path

describe('hasImport', () => {
	test('side-effect imports', () => {
		expect(hasImport("import './module'", './module')).toBe(true);
		expect(hasImport("import './module'", './other-module')).toBe(false);
	});

	test('default imports', () => {
		expect(hasImport("import defaultExport from 'module'", 'module')).toBe(
			true,
		);
		expect(
			hasImport("import defaultExport from 'module'", 'other-module'),
		).toBe(false);
	});

	test('namespace imports', () => {
		expect(hasImport("import * as name from 'module'", 'module')).toBe(true);
		expect(hasImport("import * as name from 'module'", 'other-module')).toBe(
			false,
		);
	});

	test('named imports', () => {
		expect(
			hasImport("import { export1, export2 } from 'module'", 'module'),
		).toBe(true);
		expect(
			hasImport("import { export1, export2 } from 'module'", 'other-module'),
		).toBe(false);
	});

	test('mixed imports', () => {
		expect(
			hasImport(
				"import defaultExport, { export1, export2 } from 'module'",
				'module',
			),
		).toBe(true);
		expect(
			hasImport(
				"import defaultExport, { export1, export2 } from 'module'",
				'other-module',
			),
		).toBe(false);
	});

	test('dynamic imports', () => {
		expect(hasImport("import('module')", 'module')).toBe(true);
		expect(hasImport("import('module')", 'other-module')).toBe(false);
	});

	test('export from statements', () => {
		expect(
			hasImport("export { export1, export2 } from 'module'", 'module'),
		).toBe(true);
		expect(
			hasImport("export { export1, export2 } from 'module'", 'other-module'),
		).toBe(false);
	});

	test('default export from', () => {
		expect(hasImport("export defaultExport from 'module'", 'module')).toBe(
			true,
		);
		expect(
			hasImport("export defaultExport from 'module'", 'other-module'),
		).toBe(false);
	});

	test('all exports from', () => {
		expect(hasImport("export * from 'module'", 'module')).toBe(true);
		expect(hasImport("export * from 'module'", 'other-module')).toBe(false);
	});

	test('ignores type imports', () => {
		expect(hasImport("import type { SomeType } from 'module'", 'module')).toBe(
			false,
		);
	});

	test('handles multiple imports in one line', () => {
		expect(
			hasImport(
				"import defaultExport from 'module1'; import { export1 } from 'module2'",
				'module1',
			),
		).toBe(true);
		expect(
			hasImport(
				"import defaultExport from 'module1'; import { export1 } from 'module2'",
				'module2',
			),
		).toBe(true);
		expect(
			hasImport(
				"import defaultExport from 'module1'; import { export1 } from 'module2'",
				'module3',
			),
		).toBe(false);
	});
});
