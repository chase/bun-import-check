import './a'; // d -> a -> b -> c -> d
export async function x() {
	await import('./b'); // b -> c -> d -> b
}
import('./e'); // e -> d -> e
