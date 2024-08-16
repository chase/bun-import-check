import { Transpiler, resolve as bunResolve, inspect } from 'bun';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { hasImport } from './import';
import * as resolver from './resolver';

export type ImportInfo = [originalImport: string, absolutePath: string];
async function resolveRelative(path: string, importerPath: string) {
	try {
		return await bunResolve(path, dirname(importerPath));
	} catch (e) {
		console.error(
			'Cannot resolve',
			path,
			'in',
			relative(process.cwd(), importerPath),
		);
		return undefined;
	}
}

const transpilerTsx = new Transpiler({
	target: 'bun',
	loader: 'tsx',
	logLevel: 'error',
	allowBunRuntime: false,
	deadCodeElimination: false,
});
const transpilerTs = new Transpiler({
	target: 'bun',
	loader: 'ts',
	logLevel: 'error',
	allowBunRuntime: false,
	deadCodeElimination: false,
});

function transpilerScanWithWarnPath(
	transpiler: Transpiler,
	path: string,
	code: string,
): ReturnType<Transpiler['scanImports']> {
	try {
		return transpiler.scanImports(code);
	} catch (e: any) {
		console.log();
		console.warn('Scanning error');
		console.log(inspect(e, { colors: true }).replace(/input\.[jt]sx?/g, path));
		return [];
	}
}

let resolversByDir: resolver.ResolversByDir;
async function getImports(file: string): Promise<ImportInfo[]> {
	// assume the first file's imports is the root of the dependency tree
	if (!resolversByDir) {
		resolversByDir = await resolver.getResolvers(dirname(file));
	}
	if (file.includes('/node_modules/')) return [];

	file = file.split(/[?#]/).at(0)!;
	const match = file.match(resolver.SUPPORTED_EXTENSION_REGEX);
	if (!match) return [];
	const transpiler = match[1].endsWith('x') ? transpilerTsx : transpilerTs;

	const content = readFileSync(file, {
		encoding: 'utf-8',
	});
	return (
		await Promise.all(
			transpilerScanWithWarnPath(transpiler, file, content).map(
				async ({ path }) => [
					path,
					resolver.isAmbiguousPathOrId(path)
						? await resolver.resolveAmbiguous(resolversByDir, path, file)
						: isAbsolute(path)
							? path
							: await resolveRelative(path, file),
				],
			),
		)
	).filter(
		([, resolved]) => resolved != null && !resolved.includes('/node_modules/'),
	) as ImportInfo[];
}

// biome-ignore lint/suspicious/noConstEnum: internal enum
// biome-ignore lint/style/useEnumInitializers: internal enum
const enum NodeStatus {
	Unvisited,
	Visiting,
	Visited,
}

export type DependencyNode = {
	file: string;
	imports: ImportInfo[];
};

type DependencyNodeInternal = {
	status: NodeStatus;
};

export type DependencyTree<T = never> = Map<string, DependencyNode & T>;

export type StackItem = {
	file: string;
	importIndex: number;
};

export async function buildDependencyTreeAndDetectCycles(
	entryFile: string,
): Promise<{ tree: DependencyTree; cycles: DependencyNode[][] }> {
	const tree: DependencyTree<DependencyNodeInternal> = new Map();
	const cycles: DependencyNode[][] = [];
	const stack: StackItem[] = [];
	const path: DependencyNode[] = [];

	async function pushToStack(file: string) {
		if (!tree.has(file)) {
			try {
				const imports = await getImports(file);
				tree.set(file, { file, imports, status: NodeStatus.Unvisited });
			} catch (e) {
				tree.set(file, { file, imports: [], status: NodeStatus.Unvisited });
				console.error(e);
			}
		}
		const node = tree.get(file)!;
		stack.push({ file, importIndex: 0 });
		path.push(node);
		node.status = NodeStatus.Visiting;
	}

	await pushToStack(entryFile);

	while (stack.length > 0) {
		const current = stack[stack.length - 1];
		const node = tree.get(current.file)!;

		if (current.importIndex >= node.imports.length) {
			node.status = NodeStatus.Visited;
			stack.pop();
			path.pop();
		} else {
			const [, absolutePath] = node.imports[current.importIndex];
			current.importIndex++;

			const importedNode = tree.get(absolutePath);

			if (!importedNode || importedNode.status === NodeStatus.Unvisited) {
				await pushToStack(absolutePath);
			} else if (importedNode.status === NodeStatus.Visiting) {
				const cycleStart = path.findIndex((n) => n.file === absolutePath);
				cycles.push(path.slice(cycleStart).concat(importedNode));
			}
		}
	}

	return { tree: tree as DependencyTree, cycles };
}

export type EnhancedImportInfo = {
	importer: string;
	importee: string;
	originalImport: string;
	lineNumber: number;
	line: string;
	contextLineBefore: string | undefined;
	contextLineAfter: string | undefined;
};

export type EnhancedCycleInfo = {
	cycle: DependencyNode[];
	importInfo: EnhancedImportInfo[];
};

export function enhanceCyclesWithLineInfo(
	cycles: DependencyNode[][],
): EnhancedCycleInfo[] {
	const enhancedCycles: EnhancedCycleInfo[] = [];

	for (const cycle of cycles) {
		const enhancedCycle: EnhancedCycleInfo = {
			cycle,
			importInfo: [],
		};

		for (let i = 0; i < cycle.length; i++) {
			const importer = cycle[i];
			const importee = cycle[(i + 1) % cycle.length];
			if (importer === importee) continue;
			const importInfo = findImportLineInfo(importer, importee);
			if (importInfo) {
				enhancedCycle.importInfo.push(importInfo);
			} else {
				console.error('missing import info for', { importer, importee });
			}
		}

		enhancedCycles.push(enhancedCycle);
	}

	return enhancedCycles;
}

function findImportLineInfo(
	importer: DependencyNode,
	importee: DependencyNode,
): EnhancedImportInfo | undefined {
	const filePath = importer.file;
	let fileContent: string;
	try {
		fileContent = readFileSync(filePath, 'utf-8');
	} catch (error) {
		console.error(`Error reading file ${filePath}:`, error);
		return;
	}
	const lines = fileContent.split('\n');

	// find the original import for the importee
	const importInfo = importer.imports.find(
		([, absolutePath]) => absolutePath === importee.file,
	);
	if (!importInfo) {
		console.error(
			`Could not find import info for ${importee.file} in ${importer.file}`,
		);
		return;
	}
	const [originalImport] = importInfo;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (hasImport(line, originalImport)) {
			return {
				importer: importer.file,
				importee: importee.file,
				originalImport: originalImport,
				lineNumber: i + 1,
				line,
				contextLineBefore: lines[i - 1],
				contextLineAfter: lines[i + 1],
			};
		}
	}

	return;
}
