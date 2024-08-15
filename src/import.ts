// note, this explicitly ignores type imports since they cannot introduce compile-type cycles
const IMPORT_EXPORT_REGEX =
	/(?:import|export)(?!\s+type\s+)(?:\s+(?:[^'"{}]+\s+from\s+)?|\s*\([^)]*\)\s*.|.*\s+from\s+)['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_REGEX = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function hasImport(line: string, idOrPath: string): boolean {
	for (const match of line.matchAll(IMPORT_EXPORT_REGEX)) {
		if (match[1] === idOrPath) return true;
	}
	for (const match of line.matchAll(DYNAMIC_IMPORT_REGEX)) {
		if (match[1] === idOrPath) return true;
	}
	return false;
}
