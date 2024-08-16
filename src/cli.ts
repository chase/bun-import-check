#!/usr/bin/env bun
import { parseArgs, styleText } from 'node:util';
import { basename, resolve, relative, join, dirname } from 'node:path';
import { watch } from 'node:fs';
import { findWorkspaceRoot } from './resolver';
import {
	buildDependencyTreeAndDetectCycles,
	enhanceCyclesWithLineInfo,
	type DependencyNode,
	type EnhancedImportInfo,
} from './index';

const options = {
	help: {
		type: 'boolean',
	},
	watch: {
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

const truncated = values.watch;
let linesWritten = 0;
let remainingCycles = 0;
let noLinesRemaining = false;
function resetTruncate() {
	linesWritten = 0;
	noLinesRemaining = false;
}

function truncatedLog(...data: any[]) {
	if (truncated) {
		if (linesWritten <= process.stdout.rows - 2) {
			console.log(...data);
		} else if (!noLinesRemaining) {
			noLinesRemaining = true;
			process.stdout.write(
				styleText('inverse', `...${remainingCycles} cycles truncated`),
			);
		}
		linesWritten++;
	} else {
		console.log(...data);
	}
}

const root = findWorkspaceRoot(entryFile);
function printCodeLine(
	number: number,
	maxWidth: number,
	line: string,
	bad: boolean,
	indent = 0,
) {
	const lineNumber = styleText(
		'bold',
		number.toString().padStart(maxWidth, ' '),
	);
	const indent_ = new Array(indent).fill('  ').join('');
	const separator = ' │';
	const prefix = `${bad ? '▸ ' : '  '}${lineNumber}${separator}`;
	truncatedLog(
		`${indent_}${styleText(bad ? 'red' : 'gray', prefix)} ${bad ? line : styleText('gray', line)}`,
	);
}

function printImportInfoWithIndent(info: EnhancedImportInfo, indent = 0) {
	const indent_ = new Array(indent).fill('  ').join('');
	truncatedLog(
		`${indent_}${styleText('underline', relative(root, info.importer))}:${info.lineNumber}`,
	);

	let lastContextLine = info.lineNumber;
	if (info.contextLineAfter) lastContextLine++;
	const maxWidth = lastContextLine.toString().length;
	if (info.contextLineBefore)
		printCodeLine(
			info.lineNumber - 1,
			maxWidth,
			info.contextLineBefore,
			false,
			indent,
		);
	printCodeLine(info.lineNumber, maxWidth, info.line, true, indent);
	if (info.contextLineAfter)
		printCodeLine(
			info.lineNumber + 1,
			maxWidth,
			info.contextLineAfter,
			false,
			indent,
		);
}

async function findCycles(watching: boolean) {
	truncatedLog(
		watching ? 'Watching for changes in:' : 'Workspace root:',
		join('./', relative(process.cwd(), root)),
	);

	const { cycles, tree } = await buildDependencyTreeAndDetectCycles(entryFile);
	if (cycles.length === 0) {
		truncatedLog(styleText('green', '✔ No cycles detected'));
		if (!watching) process.exit(0);
	} else {
		truncatedLog(
			styleText(
				'red',
				`✘ ${cycles.length} cycle${cycles.length > 1 ? 's' : ''} detected`,
			),
		);
	}

	const enhanced = enhanceCyclesWithLineInfo(cycles);
	remainingCycles = enhanced.length;
	for (const { importInfo } of enhanced) {
		truncatedLog();

		const last = importInfo.pop();
		printImportInfoWithIndent(last!, 0);
		for (const info of importInfo) {
			printImportInfoWithIndent(info, 1);
		}
		remainingCycles--;
	}
	if (!watching) process.exit(1);
	return tree;
}

function watchDirectories(
	tree: Map<string, DependencyNode>,
	callback: (filename: string) => void,
): () => void {
	const watchers = new Set<ReturnType<typeof watch>>();
	const watchedDirs = new Set<string>();

	for (const filename of tree.keys()) {
		const dir = dirname(filename);
		if (!watchedDirs.has(dir)) {
			const watcher = watch(
				dir,
				{ persistent: true },
				(_eventType, changedFile) => {
					const fullPath = `${dir}/${changedFile}`;
					if (tree.has(fullPath)) {
						callback(fullPath);
					}
				},
			);
			watchers.add(watcher);
			watchedDirs.add(dir);
		}
	}

	return () => {
		for (const watcher of watchers) {
			watcher.close();
		}
		watchers.clear();
		watchedDirs.clear();
	};
}

async function watchForChanges() {
	let resolveBlock: () => void;
	let watching = true;
	process.on('SIGINT', () => {
		process.stdout.clearLine(0);
		console.log();
		console.log('Exiting');
		watching = false;
		resolveBlock();
		process.exit(0);
	});
	while (watching) {
		resetTruncate();
		const block = new Promise<void>((resolve) => {
			resolveBlock = resolve;
		});
		await new Promise<void>((resolve) => {
			process.stdout.cursorTo(0);
			process.stdout.clearLine(0);
			process.stdout.clearScreenDown(resolve);
		});
		const tree = await findCycles(true);
		watchDirectories(tree, () => {
			resolveBlock();
		});
		await block;
	}
}

if (values.watch) {
	await watchForChanges();
} else {
	await findCycles(false);
}
