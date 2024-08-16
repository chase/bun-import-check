import { Glob, resolveSync } from 'bun';
import * as fs from 'node:fs';
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
} from 'node:path';
import type { TSConfckParseOptions, TSConfckParseResult } from 'tsconfck';
import { findAll, parse, parseNative, TSConfckCache } from 'tsconfck';
import type { CompilerOptions } from 'typescript';

type PathMapping = {
	pattern: string;
	glob: Glob;
	paths: string[];
};

function getPrefixLength(pattern: string): number {
	return pattern.indexOf('*');
}

function sortByPrefixLength(paths: Record<string, string[]>) {
	return Object.keys(paths).sort(
		(a: string, b: string) => getPrefixLength(b) - getPrefixLength(a),
	);
}

/** prioritizes the longest prefix match for module names*/
function resolvePathMappings(paths: Record<string, string[]>, base: string) {
	const sortedPatterns = sortByPrefixLength(paths);
	const resolved: PathMapping[] = [];
	for (const pattern of sortedPatterns) {
		const relativePaths = paths[pattern];
		resolved.push({
			pattern,
			glob: new Glob(pattern),
			paths: relativePaths.map((relativePath) => resolve(base, relativePath)),
		});
	}
	return resolved;
}

const NO_MATCH = [undefined, false] as const;

type Resolution =
	| readonly [resolvedPath: string | undefined, matched: boolean]
	| typeof NO_MATCH;

type Resolver = (idOrPath: string, importerPath: string) => Promise<Resolution>;

function hasPackageJSON(root: string) {
	return fs.existsSync(join(root, 'package.json'));
}

function findPackageRoot(path: string, root = path) {
	if (hasPackageJSON(path)) return path;

	const dir = dirname(path);
	if (!dir || dir === path) return root;

	return findPackageRoot(dir, root);
}

function readJSON(path: string) {
	return JSON.parse(fs.readFileSync(path, 'utf-8')) || {};
}

function hasWorkspacePackageJSON(root: string): boolean {
	try {
		const content = readJSON(join(root, 'package.json')) || {};
		return content.workspaces != null;
	} catch {
		return false;
	}
}

const workspaceRootCache: Record<string, string> = {};
export function findWorkspaceRoot(
	path: string,
	root = findPackageRoot(path),
): string {
	const cached = workspaceRootCache[path];
	if (cached) return cached;

	if (hasWorkspacePackageJSON(path)) {
		workspaceRootCache[path] = path;
		return path;
	}

	const dir = dirname(path);
	if (!dir || dir === path) {
		workspaceRootCache[path] = root;
		return root;
	}

	const result = findWorkspaceRoot(dir, root);
	workspaceRootCache[path] = result;
	return result;
}

async function hasTypeScriptDependency(root: string) {
	try {
		const pkg: Record<
			'dependencies' | 'devDependencies' | 'peerDependencies',
			Record<string, string>
		> = await readJSON(join(root, 'package.json'));
		return (
			pkg != null &&
			('typescript' in pkg.dependencies ||
				'typescript' in pkg.devDependencies ||
				'typescript' in pkg.peerDependencies)
		);
	} catch {
		return false;
	}
}

const tsConfckParseOptions: TSConfckParseOptions = {
	cache: new TSConfckCache(),
};
export type ResolversByDir = Record<string, Resolver[]>;
export async function getResolvers(path: string) {
	const root = findWorkspaceRoot(path);
	const tsConfigPaths = await findAll(root, {
		skip(dir) {
			return dir === 'node_modules' || dir === '.git';
		},
	});
	const parse_ = (await hasTypeScriptDependency(root)) ? parseNative : parse;
	const parsed = new Set(
		await Promise.all(
			tsConfigPaths.map((path) => parse_(path, tsConfckParseOptions)),
		),
	);
	const resolversByDir: ResolversByDir = {};
	for (const project of parsed) {
		if (!project) continue;

		if (project.referenced) {
			for (const ref of project.referenced) {
				parsed.add(ref);
			}
			project.referenced = undefined;
		} else {
			const resolver = createResolver(project);
			if (resolver) {
				const dir = normalize(dirname(project.tsconfigFile));
				resolversByDir[dir] ||= [];
				const resolvers = resolversByDir[dir];
				resolvers.push(resolver);
			}
		}
	}
	return resolversByDir;
}

export function isAmbiguousPathOrId(path: string) {
	return !RELATIVE_IMPORT_REGEX.test(path) && !isAbsolute(path);
}

export async function resolveAmbiguous(
	resolversByDir: ResolversByDir,
	idOrPath: string,
	importerPath: string,
) {
	let prevProjectDir: string | undefined;
	let projectDir = dirname(importerPath);

	// find the nearest directory with a matching tsconfig file
	outer: while (projectDir && projectDir !== prevProjectDir) {
		const resolvers = resolversByDir[projectDir];
		if (resolvers) {
			for (const resolver of resolvers) {
				const [resolved, matched] = await resolver(idOrPath, importerPath);
				if (resolved) {
					return resolved;
				}
				if (matched) {
					// Once a matching resolver is found, stop looking.
					break outer;
				}
			}
		}
		prevProjectDir = projectDir;
		projectDir = dirname(prevProjectDir);
	}
}

// not really async, but Resolvers expect a promise
// bun's resolve actually has a slight negative perf impact and isn't recommended at the moment
async function bunResolve(id: string, parent: string): Promise<Resolution> {
	// bun expects a directory, not a file path for resolution
	if (FILE_EXTENSION_REGEX.test(parent)) parent = dirname(parent);
	try {
		return [resolveSync(id, parent), true];
	} catch (e) {
		return NO_MATCH;
	}
}

type TSConfig = {
	files?: string[];
	include?: string[];
	exclude?: string[];
	compilerOptions?: CompilerOptions;
};

function isExtendedTSConfig(config: TSConfig) {
	return config.files?.length === 0 && config.include?.length === 0;
}

export const SUPPORTED_EXTENSION_REGEX = /\.([mc]?[jt]sx?)$/;
const IMPORT_PARAMETERS = /\?.+$/;
function createResolver(project: TSConfckParseResult): Resolver | null {
	const configPath = normalize(project.tsconfigFile);
	const config = project.tsconfig as TSConfig;

	// an extended tsconfig will defer to another resovler
	if (isExtendedTSConfig(config)) {
		return null;
	}

	const options = config.compilerOptions;
	if (options == null) {
		return null;
	}
	// fallback to the default resolver, since there are no tsconfig dictated path mappings
	const { baseUrl, paths } = options;
	if (!baseUrl && !paths) {
		return null;
	}

	const resolveWithBaseUrl: Resolver | undefined = baseUrl
		? (id, importerPath) => bunResolve(join(baseUrl, id), importerPath)
		: undefined;

	let resolveIdOrPath: Resolver;
	if (paths) {
		const pathMappings = resolvePathMappings(
			paths,
			baseUrl ?? dirname(configPath),
		);
		const resolveWithPaths: Resolver = async (id, importerPath) => {
			for (const mapping of pathMappings) {
				const match = mapping.glob.match(id);
				if (!match) {
					continue;
				}
				for (const path of mapping.paths) {
					let mappedId = path;
					// there are probably more edge cases here, but most common is `{
					// "something/*": ["./elsewhere/*"]
					// }`
					// replacing the prefix before the /* should work well enough
					// something/x -> ./elsewhere/x
					if (path.endsWith('/*')) {
						const mappingPrefix = mapping.pattern.replace(/\/\*$/, '');
						const pathPrefix = path.replace(/\/\*$/, '');
						mappedId = id.replace(mappingPrefix, pathPrefix);
					}

					const resolved = await bunResolve(mappedId, importerPath);
					const [, matched] = resolved;
					if (matched) {
						return resolved;
					}
				}
			}
			return NO_MATCH;
		};

		if (resolveWithBaseUrl) {
			resolveIdOrPath = (id, importerPath) =>
				resolveWithPaths(id, importerPath).then((resolved) => {
					return resolved === NO_MATCH
						? resolveWithBaseUrl(id, importerPath)
						: resolved;
				});
		} else {
			resolveIdOrPath = resolveWithPaths;
		}
	} else {
		resolveIdOrPath = resolveWithBaseUrl!;
	}

	const configDir = dirname(configPath);

	let { outDir } = options;
	// getIncluder needs a relative path
	if (outDir && isAbsolute(outDir)) {
		outDir = relative(configDir, outDir);
	}

	const isIncludedRelative = getIncluder(
		config.include,
		config.exclude,
		outDir,
	);

	const resolutionCache: Record<string, string> = {};
	return async (idOrPath, importerPath) => {
		importerPath = normalize(importerPath);
		// strip parameters like Vite ?worker, ?url, etc. from the importer path
		const importerFile = importerPath.replace(/[#?].+$/, '');

		// ignore unsupported file types
		if (!SUPPORTED_EXTENSION_REGEX.test(importerFile)) {
			return NO_MATCH;
		}

		const relativeImporterFile = relative(configDir, importerFile);
		if (!isIncludedRelative(relativeImporterFile)) {
			return NO_MATCH;
		}

		// similar to the importerFile, strip Vite parameters
		const params = IMPORT_PARAMETERS.exec(idOrPath)?.[0];
		if (params) {
			idOrPath = idOrPath.slice(0, -params.length);
		}

		let path: string | undefined = resolutionCache[idOrPath];
		if (!path) {
			const [resolvedPath, matched] = await resolveIdOrPath(
				idOrPath,
				importerFile,
			);
			if (matched && resolvedPath) {
				path = resolvedPath;
				resolutionCache[idOrPath] = resolvedPath;
			} else {
				const [fallbackPath, fallbackMatched] = await bunResolve(
					idOrPath,
					importerFile,
				);
				path = fallbackPath;
				if (fallbackMatched && fallbackPath) {
					resolutionCache[idOrPath] = fallbackPath;
				}
			}
		}
		return [path && params ? path + params : path, true];
	};
}

const RELATIVE_IMPORT_REGEX = /^\.\.?(\/|$)/;
const INCLUDE = ['**/*'];
const EXCLUDE = ['**/node_modules'];
/** @param outDir only supports relative paths */
function getIncluder(
	includePaths = INCLUDE,
	excludePaths = EXCLUDE,
	outDir?: string,
) {
	if (outDir) {
		excludePaths = excludePaths.concat(outDir);
	}
	if (includePaths.length || excludePaths.length) {
		const includers: Glob[] = [];
		const excluders: Glob[] = [];

		includePaths.forEach(addCompiledGlob, includers);
		excludePaths.forEach(addCompiledGlob, excluders);

		return (path: string) => {
			// strip query
			path = path.replace(/\?.+$/, '');
			if (!RELATIVE_IMPORT_REGEX.test(path)) {
				path = `./${path}`;
			}
			const test = (glob: Glob) => glob.match(path);
			return !excluders.some(test) && includers.some(test);
		};
	}
	return () => true;
}

const FILE_EXTENSION_REGEX = /\.\w+$/;

function addCompiledGlob(this: Glob[], pattern: string) {
	const endsWithGlob = pattern.split('/').at(-1)?.includes('*');
	const relativeGlob = RELATIVE_IMPORT_REGEX.test(pattern)
		? pattern
		: `./${pattern}`;
	if (endsWithGlob) {
		this.push(new Glob(pattern));
	} else {
		// match all directories
		this.push(new Glob(`${relativeGlob}/**`));
		// and match if its a glob with with a file extension
		if (FILE_EXTENSION_REGEX.test(pattern)) {
			this.push(new Glob(relativeGlob));
		}
	}
}
