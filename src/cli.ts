import { parseArgs, styleText } from 'node:util';
import { basename, resolve, relative, join } from 'node:path';
import { findWorkspaceRoot } from './resolver';
import {
	buildDependencyTreeAndDetectCycles,
	enhanceCyclesWithLineInfo,
	type EnhancedImportInfo,
} from './index';

const options = {
	help: {
		type: 'boolean',
	},
} as const;
const { positionals, values } = parseArgs({
	allowPositionals: true,
	options,
});

if (values.help || positionals.length !== 1) {
	console.log(`Usage: ${basename(__filename)} [OPTION]... ENTRY_POINT`);
	console.log('      --help       display this help and exit');
	console.log();
	console.log(
		'Scans the dependency tree starting from the ENTRY_POINT file and reports all cycles',
	);
	console.log('If no cycles are found, exits with 0, otherwise exits with 1');
	process.exit(0);
}

const entryFile = resolve(process.cwd(), positionals[0]);

const root = findWorkspaceRoot(entryFile);
console.log('Workspace root:', join('./', relative(process.cwd(), root)));

function printImportInfoWithIndent(info: EnhancedImportInfo, indent = 0) {
	const indent_ = new Array(indent).fill('  ').join('');
	console.log(
		`${
			indent_ + relative(root, info.importer)
		}:${info.lineNumber}:${info.line}`,
	);
}

buildDependencyTreeAndDetectCycles(entryFile).then(({ cycles }) => {
	if (cycles.length === 0) {
		console.log(styleText('green', '✔ No cycles detected'));
		process.exit(0);
	} else {
		console.log(
			styleText(
				'red',
				`✘ ${cycles.length} cycle${cycles.length > 1 ? 's' : ''} detected`,
			),
		);
	}

	const enhanced = enhanceCyclesWithLineInfo(cycles);
	for (const { importInfo } of enhanced) {
		console.log();

		const last = importInfo.pop();
		printImportInfoWithIndent(last!, 0);
		for (const info of importInfo) {
			printImportInfoWithIndent(info, 1);
		}
	}
	process.exit(1);
});
